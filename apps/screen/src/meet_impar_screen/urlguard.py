"""Keeps the AI's browser on the public internet.

The agent picks URLs from a conversation, so every page *and every request the page makes*
must resolve only to globally routable addresses: no loopback, private networks, link-local
cloud metadata endpoints or the meeting's own internal services.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
import time
from collections.abc import Awaitable, Callable
from urllib.parse import urlsplit

MAX_URL_LENGTH = 2048
DNS_CACHE_TTL_S = 60.0

Resolver = Callable[[str], Awaitable[list[str]]]


class BlockedURLError(ValueError):
    """The URL is not an http(s) address on the public internet."""


async def system_resolve(host: str) -> list[str]:
    infos = await asyncio.get_running_loop().getaddrinfo(host, None, type=socket.SOCK_STREAM)
    return [str(info[4][0]) for info in infos]


def is_public_ip(value: str) -> bool:
    try:
        addr = ipaddress.ip_address(value.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    return addr.is_global and not addr.is_multicast


def _is_ip(value: str) -> bool:
    try:
        ipaddress.ip_address(value.split("%", 1)[0])
    except ValueError:
        return False
    return True


class UrlGuard:
    """Validates URLs, caching DNS answers briefly because a page fires many requests.

    The answer that passed the check is also the one connections use
    (:meth:`public_addresses`, read by the egress proxy), so a name cannot resolve to a public
    address for the check and to a private one for the connection (DNS rebinding).
    """

    def __init__(
        self,
        resolve: Resolver = system_resolve,
        *,
        ttl_s: float = DNS_CACHE_TTL_S,
        is_public: Callable[[str], bool] = is_public_ip,
    ):
        self._resolve = resolve
        self._ttl_s = ttl_s
        self._is_public = is_public
        self._cache: dict[str, tuple[float, list[str]]] = {}

    async def public_addresses(self, host: str) -> list[str]:
        """The host's addresses when every one is public; empty when any is not (or none)."""
        literal = host.strip("[]")
        if _is_ip(literal):
            return [literal] if self._is_public(literal) else []
        now = time.monotonic()
        cached = self._cache.get(host)
        if cached and now - cached[0] < self._ttl_s:
            return cached[1]
        try:
            addresses = await self._resolve(host)
        except OSError:
            addresses = []
        public = addresses if addresses and all(self._is_public(a) for a in addresses) else []
        self._cache[host] = (now, public)
        return public

    async def check(self, url: str) -> str:
        """Returns the URL when it is allowed; raises :class:`BlockedURLError` otherwise."""
        if len(url) > MAX_URL_LENGTH:
            raise BlockedURLError("URL longa demais")
        try:
            parts = urlsplit(url.strip())
            host = parts.hostname
            parts.port  # noqa: B018 - raises ValueError on an invalid port
        except ValueError as exc:
            raise BlockedURLError("URL inválida") from exc
        if parts.scheme not in {"http", "https"} or not host:
            raise BlockedURLError("só endereços http ou https")
        if parts.username or parts.password:
            raise BlockedURLError("URL com usuário ou senha")
        if await self.public_addresses(host):
            return url.strip()
        raise BlockedURLError("endereço fora da internet pública")

    async def allows_socket(self, url: str) -> bool:
        """WebSockets follow the same rule: ws/wss are checked as http/https."""
        for socket_scheme, http_scheme in (("wss://", "https://"), ("ws://", "http://")):
            if url[: len(socket_scheme)].lower() == socket_scheme:
                return await self.allows(http_scheme + url[len(socket_scheme) :])
        return False

    async def allows(self, url: str) -> bool:
        try:
            await self.check(url)
        except BlockedURLError:
            return False
        return True
