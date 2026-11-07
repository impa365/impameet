"""Headless Chromium pages whose pixels are streamed out as JPEG frames (CDP screencast)."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import io
import logging
import time
from collections.abc import AsyncIterator, Callable, Sequence
from dataclasses import dataclass
from typing import Any

from PIL import Image
from playwright.async_api import (
    Browser,
    BrowserContext,
    CDPSession,
    Dialog,
    Locator,
    Page,
    Playwright,
    Route,
    WebSocketRoute,
    async_playwright,
)
from playwright.async_api import Error as PlaywrightError

from . import cursor, marks
from .egress import CONNECT_TIMEOUT_S, EgressProxy
from .marks import Mark, parse_marks
from .urlguard import UrlGuard

logger = logging.getLogger("meet_impar_screen.browser")

FrameSink = Callable[[bytes], None]
NAVIGATION_TIMEOUT_MS = 20_000
CLICK_TIMEOUT_MS = 5_000
JPEG_QUALITY = 80
SNAPSHOT_QUALITY = 70
SNAPSHOT_WIDTH = 1024
MAX_SNAPSHOT_TEXT = 4000
SCROLL_PX = 600
SETTLE_S = 0.4
# Resolves after the page has painted twice (i.e. without whatever was just removed).
_NEXT_PAINT_JS = "() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))"
# Text inside the viewport only: what people in the meeting can actually read.
_VISIBLE_TEXT_JS = """() => {
  const out = [];
  const walker = document.createTreeWalker(document.body || document, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = node.textContent.trim();
    const parent = node.parentElement;
    if (!text || !parent || parent.closest('#__impa_ai_cursor, #__impa_ai_marks')) continue;
    const r = node.parentElement.getBoundingClientRect();
    const style = getComputedStyle(node.parentElement);
    const offscreen = r.bottom < 0 || r.top > innerHeight || r.width === 0;
    if (offscreen || style.visibility === 'hidden') continue;
    out.push(text);
  }
  return out.join(' ').replace(/\\s+/g, ' ');
}"""


@dataclass(frozen=True)
class Snapshot:
    image: bytes
    title: str
    url: str
    text: str
    marks: tuple[Mark, ...] = ()


def shrink_jpeg(data: bytes, width: int) -> bytes:
    with Image.open(io.BytesIO(data)) as img:
        if img.width <= width:
            return data
        height = round(img.height * width / img.width)
        out = io.BytesIO()
        img.convert("RGB").resize((width, height)).save(out, "JPEG", quality=SNAPSHOT_QUALITY)
        return out.getvalue()


_LOCAL_SCHEMES = ("data:", "blob:", "about:")
_CHROMIUM_ARGS = [
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--disable-extensions",
    "--disable-sync",
    "--mute-audio",
    "--no-first-run",
    # Everything goes through the egress proxy, loopback included (Chromium bypasses the proxy
    # for loopback by default), and nothing leaves over UDP: no QUIC, no direct WebRTC.
    "--proxy-bypass-list=<-loopback>",
    "--disable-quic",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
]

# Pages shown to a meeting never need peer-to-peer connections; without these constructors a
# page cannot even try to reach internal addresses through WebRTC (ICE).
_NO_WEBRTC = """
(() => {
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel',
                      'RTCIceCandidate', 'RTCSessionDescription', 'RTCRtpSender',
                      'RTCRtpReceiver', 'RTCRtpTransceiver']) {
    try {
      Object.defineProperty(globalThis, name, {value: undefined, writable: false,
                                               configurable: false});
    } catch (e) {}
  }
})();
"""


class BrowserPage:
    """One room's screen: a sandboxed browser context that only reaches the public internet."""

    def __init__(self, context: BrowserContext, page: Page) -> None:
        self._context = context
        self._page = page
        self._tasks: set[asyncio.Task[Any]] = set()
        viewport = page.viewport_size or {"width": 1280, "height": 720}
        self._viewport = (float(viewport["width"]), float(viewport["height"]))
        self._cursor = (self._viewport[0] / 2, self._viewport[1] / 2)
        self._cdp: CDPSession | None = None
        self._screencast: dict[str, Any] = {}
        self._hiding = False
        self._visible_since = 0.0

    def _spawn(self, coro: Any) -> None:
        task = asyncio.ensure_future(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def stream_to(self, sink: FrameSink, width: int, height: int) -> None:
        cdp = await self._context.new_cdp_session(self._page)

        async def on_frame(params: dict[str, Any]) -> None:
            if self._room_may_see(params):
                sink(base64.b64decode(params["data"]))
            with contextlib.suppress(Exception):
                await cdp.send("Page.screencastFrameAck", {"sessionId": params["sessionId"]})

        cdp.on("Page.screencastFrame", lambda params: self._spawn(on_frame(params)))
        self._cdp = cdp
        self._screencast = {
            "format": "jpeg",
            "quality": JPEG_QUALITY,
            "maxWidth": width,
            "maxHeight": height,
        }
        await cdp.send("Page.startScreencast", self._screencast)

    def _room_may_see(self, params: dict[str, Any]) -> bool:
        """Frames painted while the AI-only marks were on screen never reach the room, even
        when Chromium delivers them late."""
        if self._hiding:
            return False
        painted = (params.get("metadata") or {}).get("timestamp")
        return not (isinstance(painted, int | float) and painted < self._visible_since)

    @contextlib.asynccontextmanager
    async def _room_video_paused(self) -> AsyncIterator[None]:
        """The room keeps seeing the last clean frame while marks are drawn for the AI only."""
        self._hiding = True
        if self._cdp is not None:
            with contextlib.suppress(PlaywrightError):
                await self._cdp.send("Page.stopScreencast")
        try:
            yield
        finally:
            with contextlib.suppress(PlaywrightError):
                await self._page.evaluate(_NEXT_PAINT_JS)
            self._visible_since = time.time()
            self._hiding = False
            if self._cdp is not None:
                with contextlib.suppress(PlaywrightError):
                    await self._cdp.send("Page.startScreencast", self._screencast)

    async def show_url(self, url: str) -> None:
        await self._page.goto(url, wait_until="domcontentloaded", timeout=NAVIGATION_TIMEOUT_MS)
        await self._show_cursor()

    async def show_html(self, html: str) -> None:
        await self._page.set_content(html, wait_until="domcontentloaded")
        await self._show_cursor()

    # -- the AI's mouse ---------------------------------------------------------------------

    async def _show_cursor(self) -> None:
        """(Re)draws the cursor where the AI's mouse is; new documents start without it."""
        with contextlib.suppress(PlaywrightError):
            await self._page.evaluate(cursor.INSTALL_JS)
            await self._page.mouse.move(*self._cursor)

    async def _glide_to(self, x: float, y: float) -> None:
        await self._show_cursor()
        self._cursor = await cursor.glide(self._page.mouse.move, self._cursor, (x, y))

    async def _center_of(self, target: Locator) -> tuple[float, float, dict[str, float]]:
        if await target.evaluate(cursor.CENTER_IF_NEAR_EDGE_JS, timeout=CLICK_TIMEOUT_MS):
            await asyncio.sleep(cursor.SMOOTH_SCROLL_S)
        box = await target.bounding_box()
        if box is None:
            raise PlaywrightError("element has no position on screen")
        rect = {"x": box["x"], "y": box["y"], "width": box["width"], "height": box["height"]}
        return box["x"] + box["width"] / 2, box["y"] + box["height"] / 2, rect

    async def point_text(self, text: str) -> None:
        """Glides the cursor to something on screen and highlights it, without clicking."""
        await self._point(await self._find(text))

    async def _point(self, target: Locator) -> None:
        x, y, box = await self._center_of(target)
        await self._glide_to(x, y)
        hold_ms = int(cursor.POINT_HOLD_S * 1000)
        await self._page.evaluate(
            cursor.HIGHLIGHT_JS, [box["x"], box["y"], box["width"], box["height"], hold_ms]
        )
        await asyncio.sleep(SETTLE_S)

    async def snapshot(self) -> Snapshot:
        """What the room is seeing right now, for the agent's eyes: the image (with numbered
        marks only the AI sees), the readable text and what each number is."""
        async with self._room_video_paused():
            try:
                found = parse_marks(await self._page.evaluate(marks.MARK_JS, marks.MAX_MARKS))
            except PlaywrightError:
                found = ()
            try:
                image = await self._page.screenshot(
                    type="jpeg", quality=SNAPSHOT_QUALITY, timeout=10_000
                )
            finally:
                with contextlib.suppress(PlaywrightError):
                    await self._page.evaluate(marks.CLEAR_MARKS_JS)
        text = await self._page.evaluate(_VISIBLE_TEXT_JS)
        return Snapshot(
            image=shrink_jpeg(image, SNAPSHOT_WIDTH),
            title=(await self._page.title())[:200],
            url=self._page.url if self._page.url.startswith("http") else "",
            text=str(text or "")[:MAX_SNAPSHOT_TEXT],
            marks=found,
        )

    # -- pointing without text: numbered marks and positions on the capture -----------------

    async def _mark(self, n: int) -> Locator:
        target = self._page.locator(f'[{marks.MARK_ATTRIBUTE}="{int(n)}"]')
        if await target.count() == 0:
            raise PlaywrightError(f"mark {n} is gone (the page changed); look at the screen again")
        return target.first

    def _at(self, x_pct: float, y_pct: float) -> tuple[float, float]:
        return marks.percent_to_viewport(x_pct, y_pct, *self._viewport)

    async def point_mark(self, n: int) -> None:
        await self._point(await self._mark(n))

    async def click_mark(self, n: int) -> bool:
        return await self._click(await self._mark(n))

    async def point_at(self, x_pct: float, y_pct: float) -> None:
        """Glides to a spot on the capture (a part of a chart, a face in a photo) and rings it."""
        x, y = self._at(x_pct, y_pct)
        await self._glide_to(x, y)
        await self._page.evaluate(marks.RING_JS, [x, y, int(cursor.POINT_HOLD_S * 1000)])
        await asyncio.sleep(SETTLE_S)

    async def click_at(self, x_pct: float, y_pct: float) -> bool:
        x, y = self._at(x_pct, y_pct)
        before = await self._state()
        await self._glide_to(x, y)
        await self._page.evaluate(cursor.RIPPLE_JS, [x, y])
        await self._page.mouse.click(x, y)
        return await self._settled_changed(before)

    async def scroll(self, direction: str) -> None:
        viewport = self._page.viewport_size or {"width": 1280, "height": 720}
        await self._glide_to(viewport["width"] / 2, viewport["height"] / 2)
        await self._page.mouse.wheel(0, SCROLL_PX if direction == "down" else -SCROLL_PX)
        await asyncio.sleep(SETTLE_S)

    async def _state(self) -> tuple[str, str, str]:
        text = await self._page.evaluate(_VISIBLE_TEXT_JS)
        return self._page.url, await self._page.title(), str(text or "")[:MAX_SNAPSHOT_TEXT]

    async def _find(self, text: str) -> Locator:
        """Links and buttons first: a bare text match is often a label next to the real button."""
        candidates = (
            self._page.get_by_role("link", name=text),
            self._page.get_by_role("button", name=text),
            self._page.get_by_text(text, exact=False),
        )
        for locator in candidates:
            visible = locator.filter(visible=True)
            if await visible.count() > 0:
                return visible.first
        raise PlaywrightError(f"nothing clickable with text {text!r}")

    async def click_text(self, text: str) -> bool:
        """Clicks and reports whether anything on screen actually changed."""
        return await self._click(await self._find(text))

    async def _click(self, target: Locator) -> bool:
        before = await self._state()
        x, y, _ = await self._center_of(target)
        await self._glide_to(x, y)
        await self._page.evaluate(cursor.RIPPLE_JS, [x, y])
        await target.click(timeout=CLICK_TIMEOUT_MS)
        return await self._settled_changed(before)

    async def _settled_changed(self, before: tuple[str, str, str]) -> bool:
        with contextlib.suppress(Exception):
            await self._page.wait_for_load_state("domcontentloaded", timeout=NAVIGATION_TIMEOUT_MS)
        await asyncio.sleep(SETTLE_S)
        with contextlib.suppress(Exception):  # a link that opened a new tab is being adopted
            await self._page.wait_for_load_state("domcontentloaded", timeout=NAVIGATION_TIMEOUT_MS)
        return await self._state() != before

    async def close(self) -> None:
        for task in list(self._tasks):
            task.cancel()
        with contextlib.suppress(Exception):
            await self._context.close()


class BrowserPool:
    """One Chromium process, one isolated context per room."""

    def __init__(
        self,
        guard: UrlGuard,
        width: int,
        height: int,
        *,
        extra_args: Sequence[str] = (),
        connect_timeout_s: float = CONNECT_TIMEOUT_S,
    ) -> None:
        self._guard = guard
        self._width = width
        self._height = height
        self._extra_args = list(extra_args)
        self._egress = EgressProxy(guard.public_addresses, connect_timeout_s=connect_timeout_s)
        self._playwright: Playwright | None = None
        self._browser: Browser | None = None

    async def start(self) -> None:
        proxy = await self._egress.start()
        self._playwright = await async_playwright().start()
        self._browser = await self._playwright.chromium.launch(
            args=[*_CHROMIUM_ARGS, f"--proxy-server={proxy}", *self._extra_args]
        )

    async def _route(self, route: Route) -> None:
        url = route.request.url
        if url.startswith(_LOCAL_SCHEMES) or await self._guard.allows(url):
            await route.continue_()
        else:
            await route.abort("blockedbyclient")

    async def _route_socket(self, socket: WebSocketRoute) -> None:
        """`context.route` never sees WebSockets: they get the same address check here."""
        if await self._guard.allows_socket(socket.url):
            socket.connect_to_server()
        else:
            logger.info("blocked a WebSocket outside the public internet")
            await socket.close(code=1008, reason="blocked")

    async def open_page(self, sink: FrameSink) -> BrowserPage:
        if self._browser is None:
            raise RuntimeError("browser not started")
        context = await self._browser.new_context(
            viewport={"width": self._width, "height": self._height},
            locale="pt-BR",
            accept_downloads=False,
            service_workers="block",
        )
        try:
            await context.add_init_script(_NO_WEBRTC)
            await context.route("**/*", self._route)
            await context.route_web_socket("**/*", self._route_socket)
            page = await context.new_page()
            page.on("dialog", lambda dialog: asyncio.ensure_future(_dismiss(dialog)))
            context.on(
                "page", lambda extra: asyncio.ensure_future(_adopt_popup(page, extra, self._guard))
            )
            screen = BrowserPage(context, page)
            await screen.stream_to(sink, self._width, self._height)
        except BaseException:
            await context.close()
            raise
        return screen

    async def close(self) -> None:
        if self._browser:
            await self._browser.close()
        if self._playwright:
            await self._playwright.stop()
        await self._egress.close()


async def _dismiss(dialog: Dialog) -> None:
    with contextlib.suppress(Exception):
        await dialog.dismiss()


async def _adopt_popup(main: Page, page: Page, guard: UrlGuard) -> None:
    """A link that opens a new tab would be invisible to the room: show it on the shared page."""
    if page is main:
        return
    url = ""
    with contextlib.suppress(Exception):
        await page.wait_for_load_state("domcontentloaded", timeout=NAVIGATION_TIMEOUT_MS)
        url = page.url
    with contextlib.suppress(Exception):
        await page.close()
    if url.startswith(("http://", "https://")) and await guard.allows(url):
        logger.info("opening new-tab link on the shared screen")
        with contextlib.suppress(Exception):
            await main.goto(url, wait_until="domcontentloaded", timeout=NAVIGATION_TIMEOUT_MS)
