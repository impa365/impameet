from __future__ import annotations

import asyncio
import base64
import io
import logging
import shutil
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest
from livekit import api, rtc
from PIL import Image
from playwright.async_api import Error as PlaywrightError

from meet_impar_screen import publisher
from meet_impar_screen.browser import BrowserPage, BrowserPool, _adopt_popup, shrink_jpeg
from meet_impar_screen.config import load_settings
from meet_impar_screen.notes import Notes, render
from meet_impar_screen.publisher import LiveKitScreen, jpeg_to_frame, screen_token
from meet_impar_screen.server import RoomScreen, create_service, make_opener, quiet_stream_noise
from meet_impar_screen.urlguard import UrlGuard

SETTINGS = load_settings(
    {
        "LIVEKIT_URL": "wss://lk.example.com",
        "LIVEKIT_API_KEY": "APIkey",
        "LIVEKIT_API_SECRET": "a-very-long-livekit-secret-for-tests-0123456789",
        "SCREEN_TOKEN": "t",
    }
)


def jpeg(width: int, height: int, color: tuple[int, int, int] = (200, 10, 10)) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (width, height), color).save(out, "JPEG")
    return out.getvalue()


def test_screen_token_only_publishes_a_screen_share() -> None:
    token = screen_token(SETTINGS, "t.sala")
    claims = api.TokenVerifier("APIkey", SETTINGS.livekit_api_secret.get_secret_value()).verify(
        token
    )
    assert claims.identity == "ai-screen"
    assert claims.name == "Tela da IA"
    assert claims.kind == "agent"
    video = claims.video
    assert video is not None
    assert (video.room, video.room_join, video.can_subscribe) == ("t.sala", True, False)
    assert video.can_publish_data is False
    assert video.can_publish_sources == ["screen_share"]


class FakeTab:
    def __init__(self, url: str = "", fail: bool = False) -> None:
        self.url = url
        self.fail = fail
        self.closed = False
        self.visited: list[str] = []

    async def wait_for_load_state(self, *_: Any, **__: Any) -> None:
        if self.fail:
            raise PlaywrightError("timeout")

    async def close(self) -> None:
        self.closed = True

    async def goto(self, url: str, **_: Any) -> None:
        self.visited.append(url)


@pytest.mark.parametrize(
    ("url", "public", "opened"),
    [
        ("https://example.com/precos", True, True),
        ("https://intranet.local/", False, False),
        ("about:blank", True, False),
    ],
)
async def test_new_tab_links_open_on_the_shared_screen(
    url: str, public: bool, opened: bool
) -> None:
    async def resolve(host: str) -> list[str]:
        return ["93.184.215.14"] if public else ["10.0.0.1"]

    main, popup = FakeTab("https://example.com/"), FakeTab(url)
    await _adopt_popup(main, popup, UrlGuard(resolve))  # type: ignore[arg-type]
    assert popup.closed
    assert main.visited == ([url] if opened else [])


async def test_the_shared_page_itself_is_never_closed() -> None:
    main = FakeTab("https://example.com/")
    await _adopt_popup(main, main, UrlGuard())  # type: ignore[arg-type]
    assert not main.closed
    stuck = FakeTab("https://example.com/", fail=True)
    await _adopt_popup(main, stuck, UrlGuard())  # type: ignore[arg-type]
    assert stuck.closed
    assert main.visited == []


def test_stream_noise_is_dropped_from_logs() -> None:
    def record(msg: str) -> logging.LogRecord:
        return logging.LogRecord("root", logging.INFO, "", 0, msg, None, None)

    assert not quiet_stream_noise(record("ignoring byte stream with topic 'lk.agent.session'"))
    assert quiet_stream_noise(record("share on t.sala: page"))


def test_snapshots_are_shrunk_for_the_model() -> None:
    big = jpeg(2048, 1152)
    small = shrink_jpeg(big, 1024)
    assert Image.open(io.BytesIO(small)).size == (1024, 576)
    already = jpeg(800, 450)
    assert shrink_jpeg(already, 1024) is already


def test_jpeg_frames_are_letterboxed_to_the_track_size() -> None:
    same = jpeg_to_frame(jpeg(64, 36), 64, 36)
    assert (same.width, same.height, same.type) == (64, 36, rtc.VideoBufferType.RGBA)
    boxed = jpeg_to_frame(jpeg(32, 32), 64, 36)
    data = bytes(boxed.data)
    assert (boxed.width, boxed.height) == (64, 36)
    assert data[:4] == bytes((22, 24, 29, 255))
    middle = (18 * 64 + 32) * 4
    assert data[middle] > 150


class FakeRoom:
    def __init__(self) -> None:
        self.handlers: dict[str, Any] = {}
        self.remote_participants: dict[str, object] = {}
        self.local_participant = self
        self.published: list[Any] = []
        self.disconnected = False

    def on(self, event: str, fn: Any) -> None:
        self.handlers[event] = fn

    async def connect(self, url: str, token: str) -> None:
        self.url = url

    async def publish_track(self, track: Any, options: Any) -> None:
        self.published.append(options)

    async def disconnect(self) -> None:
        self.disconnected = True


async def test_live_screen_publishes_repeats_frames_and_expires(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(publisher, "KEEPALIVE_S", 0.01)
    screen = LiveKitScreen(64, 36)
    room = FakeRoom()
    screen._room = room  # type: ignore[assignment]
    captured: list[object] = []
    screen._source.capture_frame = captured.append  # type: ignore[method-assign]

    await screen.connect("wss://lk", "tok")
    assert room.published[0].source == rtc.TrackSource.SOURCE_SCREENSHARE
    assert screen.expired(10**9)  # alone in the room for longer than the grace period

    room.remote_participants["guest"] = object()
    room.handlers["participant_connected"]()
    assert not screen.expired(10**9)
    screen.push_jpeg(jpeg(64, 36))
    screen.push_jpeg(b"not a jpeg")
    for _ in range(200):
        if len(captured) > 2:
            break
        await asyncio.sleep(0.01)
    assert len(captured) > 2

    room.handlers["disconnected"]()
    assert screen.expired(0)
    await screen.close()
    assert room.disconnected


chromium = pytest.mark.skipif(
    not (shutil.which("chromium") or any(Path.home().glob(".cache/ms-playwright/chromium*")))
    and not Path("/opt/ms-playwright").exists(),
    reason="Playwright Chromium is not installed",
)


@pytest.mark.browser
@chromium
async def test_real_browser_streams_notes_and_blocks_private_requests() -> None:
    async def resolve(host: str) -> list[str]:
        return ["10.0.0.1"]

    pool = BrowserPool(UrlGuard(resolve), 640, 360)
    frames: list[bytes] = []
    await pool.start()
    try:
        page = await pool.open_page(frames.append)
        await page.show_html(render(Notes.create("Resumo", ["Ponto um", "Ponto dois"]), "Kaiser"))
        for _ in range(50):
            if frames:
                break
            await asyncio.sleep(0.1)
        assert frames
        assert Image.open(io.BytesIO(frames[-1])).size == (640, 360)

        shot = await page.snapshot()
        assert "Ponto um" in shot.text
        assert "Resumo" in shot.text
        assert Image.open(io.BytesIO(shot.image)).format == "JPEG"
        await page.scroll("down")
        await page.scroll("up")
        with pytest.raises(PlaywrightError):
            await page.click_text("texto que não existe")
        assert await page.click_text("Ponto dois") is False  # plain text: nothing happens

        # The real button wins over a paragraph that mentions the same words.
        await page.show_html(
            "<p>Clique em Abrir página para continuar</p>"
            "<button onclick=\"document.body.innerHTML='<h1>Página aberta</h1>'\">"
            "Abrir página</button>"
        )
        assert await page.click_text("Abrir página") is True
        assert "Página aberta" in (await page.snapshot()).text

        # Everyone sees the AI's cursor glide to what it points at, with a highlight.
        spacer = "<div style='height:1500px'></div>"
        await page.show_html(f"{spacer}<h2 id='pro'>Plano Pro R$ 99</h2>{spacer}")
        await page.point_text("Plano Pro")
        where = await page._page.evaluate(
            """() => {
              const c = document.getElementById('__impa_ai_cursor').getBoundingClientRect();
              const t = document.getElementById('pro').getBoundingClientRect();
              const h = document.querySelector('.__impa_ai_highlight');
              return {cx: c.left + 2, cy: c.top + 2, tx: t.left + t.width / 2,
                      ty: t.top + t.height / 2, highlight: !!h, top: t.top};
            }"""
        )
        assert where["highlight"]
        assert 360 * 0.15 <= where["top"] < 360 * 0.85  # smoothly brought to the middle
        assert abs(where["cx"] - where["tx"]) < 4
        assert abs(where["cy"] - where["ty"]) < 4
        assert "IA" not in (await page.snapshot()).text.split()  # the label is not page text

        with pytest.raises(PlaywrightError, match="ERR_BLOCKED_BY_CLIENT"):
            await page.show_url("http://intranet.test/")
        await page.close()
    finally:
        await pool.close()


def test_frames_painted_while_marks_were_shown_never_reach_the_room() -> None:
    page = BrowserPage(MagicMock(), MagicMock(viewport_size={"width": 640, "height": 360}))
    page._visible_since = 100.0
    assert page._room_may_see({"metadata": {"timestamp": 101.0}})
    assert not page._room_may_see({"metadata": {"timestamp": 99.5}})
    assert page._room_may_see({"metadata": {}})
    assert page._room_may_see({})
    page._hiding = True
    assert not page._room_may_see({"metadata": {"timestamp": 101.0}})


def _has_mark_color(jpeg_bytes: bytes) -> bool:
    """The marks' magenta (#e0137a), allowing for JPEG artefacts."""
    with Image.open(io.BytesIO(jpeg_bytes)) as img:
        pixels = img.convert("RGB").getdata()
        return any(abs(r - 224) < 40 and g < 80 and abs(b - 122) < 50 for r, g, b in pixels)


def _png_data_url() -> str:
    out = io.BytesIO()
    Image.new("RGB", (12, 8), (40, 160, 90)).save(out, "PNG")
    return "data:image/png;base64," + base64.b64encode(out.getvalue()).decode()


NO_TEXT_PAGE = """<body style="margin:0;background:#fff">
<button id="gear" onclick="document.getElementById('out').textContent='engrenagem clicada'"
  style="position:absolute;left:40px;top:40px;width:48px;height:48px;border:0;background:#ddd">
  <svg width="24" height="24"><circle cx="12" cy="12" r="10" fill="#333"/></svg></button>
<img id="photo" alt="" src="__IMG__"
  style="position:absolute;left:200px;top:40px;width:120px;height:80px">
<canvas id="chart" width="200" height="120" style="position:absolute;left:380px;top:40px"></canvas>
<div id="spot" onclick="document.getElementById('out').textContent='ponto clicado'"
  style="position:absolute;left:0;top:220px;width:640px;height:140px"></div>
<p id="out" style="position:absolute;left:40px;top:170px;margin:0"></p>
</body>"""

CURSOR_AT_JS = """() => {
  const c = document.getElementById('__impa_ai_cursor').getBoundingClientRect();
  return [c.left + 2, c.top + 2];
}"""


@pytest.mark.browser
@chromium
async def test_real_browser_points_at_things_without_text() -> None:
    async def resolve(host: str) -> list[str]:
        return ["10.0.0.1"]

    pool = BrowserPool(UrlGuard(resolve), 640, 360)
    frames: list[bytes] = []
    await pool.start()
    try:
        page = await pool.open_page(frames.append)
        await page.show_html(NO_TEXT_PAGE.replace("__IMG__", _png_data_url()))
        await asyncio.sleep(0.3)

        # The AI's capture carries numbered marks on the icon button, the image and the chart...
        frames.clear()
        shot = await page.snapshot()
        by_kind = {m.kind: m for m in reversed(shot.marks)}
        assert {"botão", "imagem", "gráfico"} <= set(by_kind)
        assert _has_mark_color(shot.image)
        assert await page._page.evaluate("() => document.getElementById('__impa_ai_marks')") is None

        # ...but the room never sees them.
        await page._page.evaluate("() => { document.body.style.background = '#fafafa'; }")
        for _ in range(30):
            if frames:
                break
            await asyncio.sleep(0.1)
        assert frames
        assert not any(_has_mark_color(f) for f in frames)

        chart = by_kind["gráfico"]
        await page.point_mark(chart.n)
        x, y = await page._page.evaluate(CURSOR_AT_JS)
        assert abs(x - 480) < 4
        assert abs(y - 100) < 4

        gear = next(m for m in shot.marks if m.kind == "botão" and m.x < 100)
        assert await page.click_mark(gear.n) is True
        assert "engrenagem clicada" in (await page.snapshot()).text

        await page.point_at(50, 75)
        x, y = await page._page.evaluate(CURSOR_AT_JS)
        assert abs(x - 320) < 4
        assert abs(y - 270) < 4
        assert await page._page.evaluate("() => !!document.querySelector('.__impa_ai_highlight')")
        assert await page.click_at(50, 75) is True
        assert "ponto clicado" in (await page.snapshot()).text

        # Numbers belong to one capture: after the page changes they must be looked up again.
        await page.show_html("<p>outra página</p>")
        with pytest.raises(PlaywrightError, match="gone"):
            await page.point_mark(chart.n)
        await page.close()
    finally:
        await pool.close()


async def test_room_screen_wires_page_and_track(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    class Page:
        async def show_url(self, url: str) -> None:
            calls.append(f"url {url}")

        async def show_html(self, html: str) -> None:
            calls.append("html")

        async def snapshot(self) -> str:
            calls.append("snapshot")
            return "shot"

        async def scroll(self, direction: str) -> None:
            calls.append(f"scroll {direction}")

        async def click_text(self, text: str) -> bool:
            calls.append(f"click {text}")
            return True

        async def point_text(self, text: str) -> None:
            calls.append(f"point {text}")

        async def point_mark(self, n: int) -> None:
            calls.append(f"point_mark {n}")

        async def click_mark(self, n: int) -> bool:
            calls.append(f"click_mark {n}")
            return True

        async def point_at(self, x: float, y: float) -> None:
            calls.append(f"point_at {x},{y}")

        async def click_at(self, x: float, y: float) -> bool:
            calls.append(f"click_at {x},{y}")
            return False

        async def close(self) -> None:
            calls.append("page closed")

    class Screen:
        def __init__(self, width: int, height: int) -> None:
            calls.append(f"screen {width}x{height}")

        async def connect(self, url: str, token: str) -> None:
            calls.append(f"connect {url}")

        def push_jpeg(self, data: bytes) -> None: ...

        def expired(self, now: float) -> bool:
            return now > 1

        async def close(self) -> None:
            calls.append("screen closed")

    class Pool:
        fail = False

        async def open_page(self, sink: Any) -> Page:
            if self.fail:
                raise RuntimeError("no browser")
            return Page()

    monkeypatch.setattr("meet_impar_screen.server.LiveKitScreen", Screen)
    pool = Pool()
    opener = make_opener(SETTINGS, pool)  # type: ignore[arg-type]
    display = await opener("t.sala")
    assert isinstance(display, RoomScreen)
    await display.show_url("https://example.com/")
    await display.show_html("<p>")
    assert await display.snapshot() == "shot"  # type: ignore[comparison-overlap]
    await display.scroll("up")
    assert await display.click_text("Entrar") is True
    await display.point_text("Preço")
    await display.point_mark(3)
    assert await display.click_mark(3) is True
    await display.point_at(10, 20)
    assert await display.click_at(10, 20) is False
    assert display.expired(2)
    assert not display.expired(0)
    await display.close()
    assert calls == [
        "screen 1280x720",
        "connect wss://lk.example.com/",
        "url https://example.com/",
        "html",
        "snapshot",
        "scroll up",
        "click Entrar",
        "point Preço",
        "point_mark 3",
        "click_mark 3",
        "point_at 10,20",
        "click_at 10,20",
        "page closed",
        "screen closed",
    ]

    pool.fail = True
    calls.clear()
    with pytest.raises(RuntimeError):
        await opener("t.sala")
    assert calls[-1] == "screen closed"


async def test_service_lifecycle_starts_and_stops_the_browser(
    monkeypatch: pytest.MonkeyPatch, aiohttp_client: Any
) -> None:
    events: list[str] = []

    async def start(self: BrowserPool) -> None:
        events.append("start")

    async def close(self: BrowserPool) -> None:
        events.append("close")

    monkeypatch.setattr(BrowserPool, "start", start)
    monkeypatch.setattr(BrowserPool, "close", close)
    client = await aiohttp_client(create_service(SETTINGS))
    assert (await client.get("/health")).status == 200
    await client.close()
    assert events == ["start", "close"]
