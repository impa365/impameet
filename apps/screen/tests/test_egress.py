"""The AI browser cannot reach internal services: WebSockets, WebRTC and DNS rebinding.

The real-browser tests are written so that each one fails without its fix: the page or the
browser really tries to reach a server on loopback, and the server must never be reached.
"""

from __future__ import annotations

import asyncio
import shutil
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from aiohttp import WSMsgType, web

from meet_impar_screen.browser import BrowserPool
from meet_impar_screen.egress import EgressProxy, _host_port
from meet_impar_screen.urlguard import UrlGuard

PUBLIC = "93.184.215.14"

chromium = pytest.mark.skipif(
    not (shutil.which("chromium") or any(Path.home().glob(".cache/ms-playwright/chromium*")))
    and not Path("/opt/ms-playwright").exists(),
    reason="Playwright Chromium is not installed",
)


class InternalService:
    """A loopback HTTP + WebSocket server standing in for a service inside the stack."""

    def __init__(self) -> None:
        self.hits: list[str] = []
        self.port = 0
        self._runner: web.AppRunner | None = None

    async def _http(self, request: web.Request) -> web.Response:
        self.hits.append(request.path)
        return web.Response(text="internal-secret")

    async def _ws(self, request: web.Request) -> web.WebSocketResponse:
        self.hits.append(request.path)
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        await ws.send_str("internal-secret")
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                await ws.send_str(f"echo:{msg.data}")
        return ws

    async def __aenter__(self) -> InternalService:
        app = web.Application()
        app.router.add_get("/ws", self._ws)
        app.router.add_get("/{tail:.*}", self._http)
        self._runner = web.AppRunner(app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, "127.0.0.1", 0)
        await site.start()
        self.port = site._server.sockets[0].getsockname()[1]  # type: ignore[union-attr]
        return self

    async def __aexit__(self, *_: object) -> None:
        if self._runner:
            await self._runner.cleanup()


@pytest.fixture
async def service() -> AsyncIterator[InternalService]:
    async with InternalService() as svc:
        yield svc


async def _proxy_request(proxy: str, raw: bytes) -> bytes:
    host, port = proxy.removeprefix("http://").split(":")
    reader, writer = await asyncio.open_connection(host, int(port))
    writer.write(raw)
    await writer.drain()
    try:
        return await asyncio.wait_for(reader.read(65536), 5)
    finally:
        writer.close()


# -- the proxy itself ---------------------------------------------------------------------


def test_connect_targets_are_parsed_strictly() -> None:
    assert _host_port("example.com:443", 443) == ("example.com", 443)
    assert _host_port("example.com", 80) == ("example.com", 80)
    assert _host_port("[2001:db8::1]:8443", 443) == ("2001:db8::1", 8443)
    assert _host_port("example.com:99999", 443) is None
    assert _host_port("example.com:abc", 443) is None
    assert _host_port(":443", 443) is None


async def test_proxy_forwards_only_to_checked_addresses(service: InternalService) -> None:
    async def lookup(host: str) -> list[str]:
        return ["127.0.0.1"] if host == "site.test" else []

    proxy = EgressProxy(lookup)
    url = await proxy.start()
    try:
        ok = await _proxy_request(
            url, f"GET http://site.test:{service.port}/hello HTTP/1.1\r\nHost: x\r\n\r\n".encode()
        )
        assert ok.startswith(b"HTTP/1.1 200")
        assert b"internal-secret" in ok

        tunnel = await _proxy_request(
            url, f"CONNECT site.test:{service.port} HTTP/1.1\r\n\r\n".encode()
        )
        assert tunnel.startswith(b"HTTP/1.1 200 Connection Established")

        refused = await _proxy_request(
            url, f"CONNECT other.test:{service.port} HTTP/1.1\r\n\r\n".encode()
        )
        assert refused.startswith(b"HTTP/1.1 403")
        plain = await _proxy_request(
            url, f"GET http://127.0.0.1:{service.port}/ HTTP/1.1\r\n\r\n".encode()
        )
        assert plain.startswith(b"HTTP/1.1 403")
        assert (await _proxy_request(url, b"nonsense\r\n\r\n")).startswith(b"HTTP/1.1 400")
        assert (await _proxy_request(url, b"GET ftp://x/ HTTP/1.1\r\n\r\n")).startswith(
            b"HTTP/1.1 400"
        )
        assert service.hits == ["/hello"]
    finally:
        await proxy.close()


async def test_unreachable_checked_address_is_a_bad_gateway() -> None:
    async def lookup(host: str) -> list[str]:
        return ["127.0.0.1"]

    proxy = EgressProxy(lookup, connect_timeout_s=1)
    url = await proxy.start()
    try:
        # Port 9 (discard) is closed on loopback: the connection is refused.
        answer = await _proxy_request(url, b"CONNECT site.test:9 HTTP/1.1\r\n\r\n")
        assert answer.startswith(b"HTTP/1.1 502")
    finally:
        await proxy.close()


# -- the guard ----------------------------------------------------------------------------


async def test_websockets_get_the_same_address_rule() -> None:
    async def resolve(host: str) -> list[str]:
        return {"public.test": [PUBLIC], "inside.test": ["10.0.0.5"]}.get(host, [])

    guard = UrlGuard(resolve)
    assert await guard.allows_socket("wss://public.test/live")
    assert await guard.allows_socket("WS://public.test:8080/live")
    assert not await guard.allows_socket("ws://inside.test/live")
    assert not await guard.allows_socket("ws://127.0.0.1:9911/")
    assert not await guard.allows_socket("wss://[::1]/")
    assert not await guard.allows_socket("https://public.test/")  # not a socket URL


async def test_the_checked_answer_is_the_one_connections_use() -> None:
    answers = [[PUBLIC], ["127.0.0.1"]]  # a rebinding name: public first, private next

    async def resolve(host: str) -> list[str]:
        return answers.pop(0) if answers else ["127.0.0.1"]

    guard = UrlGuard(resolve)
    assert await guard.allows("http://rebind.test/")
    assert await guard.public_addresses("rebind.test") == [PUBLIC]  # not re-resolved
    assert await guard.public_addresses("10.1.2.3") == []
    assert await guard.public_addresses(PUBLIC) == [PUBLIC]


# -- the real browser ---------------------------------------------------------------------

WAIT_SCRIPT = """
async ([url, ms]) => {
  return await new Promise((done) => {
    let ws;
    try { ws = new WebSocket(url); } catch (e) { return done('error:' + e.name); }
    const timer = setTimeout(() => done('timeout'), ms);
    ws.onmessage = (m) => { clearTimeout(timer); done('received:' + m.data); };
    ws.onerror = () => { clearTimeout(timer); done('blocked'); };
    ws.onclose = () => { clearTimeout(timer); done('blocked'); };
  });
}
"""


@pytest.mark.browser
@chromium
async def test_real_browser_websockets_never_reach_internal_services(
    service: InternalService,
) -> None:
    async def resolve(host: str) -> list[str]:
        return {"inside.test": ["10.0.0.5"]}.get(host, [PUBLIC])

    pool = BrowserPool(UrlGuard(resolve), 640, 360, connect_timeout_s=2)
    await pool.start()
    try:
        page = await pool.open_page(lambda _: None)
        await page.show_html("<h1>Página da IA</h1>")
        loopback = await page._page.evaluate(
            WAIT_SCRIPT, [f"ws://127.0.0.1:{service.port}/ws", 4000]
        )
        named = await page._page.evaluate(
            WAIT_SCRIPT, [f"ws://inside.test:{service.port}/ws", 4000]
        )
        assert loopback == "blocked"
        assert named == "blocked"
        assert service.hits == []  # the internal service never saw a connection
        await page.close()
    finally:
        await pool.close()


@pytest.mark.browser
@chromium
async def test_real_browser_still_reaches_allowed_sites_through_the_proxy(
    service: InternalService,
) -> None:
    """Loopback plays the public internet here, to prove allowed traffic still flows."""

    async def resolve(host: str) -> list[str]:
        return ["127.0.0.1"]

    guard = UrlGuard(resolve, is_public=lambda ip: ip == "127.0.0.1")
    pool = BrowserPool(guard, 640, 360, connect_timeout_s=2)
    await pool.start()
    try:
        page = await pool.open_page(lambda _: None)
        await page.show_url(f"http://site.test:{service.port}/page")
        assert "internal-secret" in (await page.snapshot()).text
        socket = await page._page.evaluate(WAIT_SCRIPT, [f"ws://site.test:{service.port}/ws", 4000])
        assert socket == "received:internal-secret"
        assert service.hits == ["/page", "/ws"]
        await page.close()
    finally:
        await pool.close()


ICE_SCRIPT = """
async () => {
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  const result = {
    main: typeof window.RTCPeerConnection,
    frame: typeof frame.contentWindow.RTCPeerConnection,
    candidates: [],
  };
  const PC = window.RTCPeerConnection || frame.contentWindow.RTCPeerConnection;
  if (!PC) return result;
  const pc = new PC({iceServers: []});
  pc.createDataChannel('x');
  await new Promise(async (done) => {
    pc.onicecandidate = (e) => { if (e.candidate) result.candidates.push(e.candidate.candidate);
                                 else done(); };
    setTimeout(done, 3000);
    await pc.setLocalDescription(await pc.createOffer());
  });
  pc.close();
  return result;
}
"""


@pytest.mark.browser
@chromium
async def test_real_browser_pages_cannot_open_webrtc_paths() -> None:
    async def resolve(host: str) -> list[str]:
        return [PUBLIC]

    pool = BrowserPool(UrlGuard(resolve), 640, 360, connect_timeout_s=2)
    await pool.start()
    try:
        page = await pool.open_page(lambda _: None)
        await page.show_html("<h1>Página da IA</h1>")
        result = await page._page.evaluate(ICE_SCRIPT)
        assert result["main"] == "undefined"
        # Even a constructor fished out of a fresh iframe gathers no direct (UDP) candidates:
        # there is no host or STUN path to private addresses.
        assert result["candidates"] == []
        await page.close()
    finally:
        await pool.close()


@pytest.mark.browser
@chromium
async def test_real_browser_ignores_dns_rebinding(service: InternalService) -> None:
    """The name answers a public address to the check and loopback to the browser.

    `--host-resolver-rules` makes Chromium's own resolver return loopback for the name, as an
    attacker's DNS server would on the second lookup. Since Chromium never resolves names
    itself (the egress proxy connects to the address that was checked), loopback is not hit.
    """

    async def resolve(host: str) -> list[str]:
        return [PUBLIC]

    pool = BrowserPool(
        UrlGuard(resolve),
        640,
        360,
        extra_args=["--host-resolver-rules=MAP rebind.test 127.0.0.1"],
        connect_timeout_s=2,
    )
    await pool.start()
    try:
        page = await pool.open_page(lambda _: None)
        await page.show_html("<h1>Página da IA</h1>")
        fetched = await page._page.evaluate(
            """async (url) => {
                 try { const r = await fetch(url); return 'read:' + await r.text(); }
                 catch (e) { return 'failed'; }
               }""",
            f"http://rebind.test:{service.port}/secret",
        )
        socket = await page._page.evaluate(
            WAIT_SCRIPT, [f"ws://rebind.test:{service.port}/ws", 4000]
        )
        assert "internal-secret" not in fetched
        assert "internal-secret" not in socket
        assert service.hits == []
        await page.close()
    finally:
        await pool.close()
