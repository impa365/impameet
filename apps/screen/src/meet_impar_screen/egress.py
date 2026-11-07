"""The AI browser's only way out: a local proxy that pins every connection to a checked address.

Chromium sends all its traffic (pages, sub-resources, WebSockets) through this proxy and never
resolves names itself. The proxy resolves each host once through the :class:`UrlGuard`, refuses
it unless every address is public, and connects to exactly that address. A name that answers a
public address to the check and a private one to the connection (DNS rebinding) therefore
cannot reach internal services, whatever the protocol.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable
from urllib.parse import urlsplit

logger = logging.getLogger("meet_impar_screen.egress")

AddressLookup = Callable[[str], Awaitable[list[str]]]

MAX_HEADER_BYTES = 64 * 1024
HEADER_TIMEOUT_S = 15.0
CONNECT_TIMEOUT_S = 10.0
CHUNK = 64 * 1024
_HOP_BY_HOP = {"connection", "keep-alive", "proxy-connection", "proxy-authorization", "te"}
_FORBIDDEN = b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
_BAD_REQUEST = b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
_BAD_GATEWAY = b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"


def _host_port(target: str, default_port: int) -> tuple[str, int] | None:
    host, sep, port = target.rpartition(":")
    if not sep or "]" in port:
        host, port = target, str(default_port)
    try:
        number = int(port)
    except ValueError:
        return None
    host = host.strip("[]")
    return (host, number) if host and 0 < number < 65536 else None  # noqa: PLR2004


class EgressProxy:
    """HTTP proxy on loopback (CONNECT for TLS and WebSockets, absolute-form for plain HTTP)."""

    def __init__(
        self, addresses: AddressLookup, *, connect_timeout_s: float = CONNECT_TIMEOUT_S
    ) -> None:
        self._addresses = addresses
        self._connect_timeout_s = connect_timeout_s
        self._server: asyncio.Server | None = None
        self._tasks: set[asyncio.Task[None]] = set()

    async def start(self) -> str:
        """Listens on an ephemeral loopback port and returns the proxy URL for Chromium."""
        self._server = await asyncio.start_server(self._accept, "127.0.0.1", 0)
        port = self._server.sockets[0].getsockname()[1]
        return f"http://127.0.0.1:{port}"

    async def close(self) -> None:
        if self._server:
            self._server.close()
        for task in list(self._tasks):
            task.cancel()
        if self._server:
            with contextlib.suppress(Exception):
                await self._server.wait_closed()

    def _accept(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        task = asyncio.ensure_future(self._serve(reader, writer))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), HEADER_TIMEOUT_S)
            if len(head) > MAX_HEADER_BYTES:
                raise ValueError("header too large")
            line, *headers = head[:-4].decode("latin-1").split("\r\n")
            method, target, version = line.split(" ", 2)
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, TimeoutError, ValueError):
            await self._reply(writer, _BAD_REQUEST)
            return
        if method.upper() == "CONNECT":
            await self._tunnel(reader, writer, target)
        else:
            await self._forward(
                reader, writer, method=method, target=target, version=version, headers=headers
            )

    async def _open(
        self, host: str, port: int
    ) -> tuple[asyncio.StreamReader, asyncio.StreamWriter] | None:
        """Connects to one of the host's checked public addresses, never to anything else."""
        addresses = await self._addresses(host)
        if not addresses:
            logger.info("blocked a connection outside the public internet")
            return None
        for address in addresses:
            with contextlib.suppress(OSError, TimeoutError):
                return await asyncio.wait_for(
                    asyncio.open_connection(address, port), self._connect_timeout_s
                )
        return None

    async def _tunnel(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, target: str
    ) -> None:
        parsed = _host_port(target, 443)
        if parsed is None:
            await self._reply(writer, _BAD_REQUEST)
            return
        if not await self._addresses(parsed[0]):
            await self._reply(writer, _FORBIDDEN)
            return
        upstream = await self._open(*parsed)
        if upstream is None:
            await self._reply(writer, _BAD_GATEWAY)
            return
        writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        await self._relay(reader, writer, *upstream)

    async def _forward(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        *,
        method: str,
        target: str,
        version: str,
        headers: list[str],
    ) -> None:
        parts = urlsplit(target)
        if parts.scheme != "http" or not parts.hostname:
            await self._reply(writer, _BAD_REQUEST)
            return
        try:
            port = parts.port or 80
        except ValueError:
            await self._reply(writer, _BAD_REQUEST)
            return
        if not await self._addresses(parts.hostname):
            await self._reply(writer, _FORBIDDEN)
            return
        upstream = await self._open(parts.hostname, port)
        if upstream is None:
            await self._reply(writer, _BAD_GATEWAY)
            return
        path = parts.path or "/"
        if parts.query:
            path = f"{path}?{parts.query}"
        kept = [h for h in headers if h.split(":", 1)[0].strip().lower() not in _HOP_BY_HOP]
        # One request per connection: Chromium may reuse a proxy connection for another host.
        head = "\r\n".join([f"{method} {path} {version}", *kept, "Connection: close", "", ""])
        upstream[1].write(head.encode("latin-1"))
        await self._relay(reader, writer, *upstream)

    async def _relay(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        up_reader: asyncio.StreamReader,
        up_writer: asyncio.StreamWriter,
    ) -> None:
        await asyncio.gather(_pipe(reader, up_writer), _pipe(up_reader, writer))

    async def _reply(self, writer: asyncio.StreamWriter, response: bytes) -> None:
        with contextlib.suppress(OSError):
            writer.write(response)
            await writer.drain()
        writer.close()


async def _pipe(src: asyncio.StreamReader, dst: asyncio.StreamWriter) -> None:
    try:
        while data := await src.read(CHUNK):
            dst.write(data)
            await dst.drain()
    except (OSError, asyncio.IncompleteReadError):
        pass
    finally:
        with contextlib.suppress(OSError):
            dst.close()
