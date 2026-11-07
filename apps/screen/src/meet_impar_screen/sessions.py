"""One shared screen per room: opened on demand, reused, and closed when idle or abandoned."""

from __future__ import annotations

import asyncio
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Protocol

from .browser import Snapshot
from .notes import Notes, render
from .urlguard import UrlGuard

ROOM_RE = re.compile(r"^[A-Za-z0-9._-]{1,200}$")


class Display(Protocol):
    async def show_url(self, url: str) -> None: ...
    async def show_html(self, html: str) -> None: ...
    async def snapshot(self) -> Snapshot: ...
    async def scroll(self, direction: str) -> None: ...
    async def click_text(self, text: str) -> bool: ...
    async def point_text(self, text: str) -> None: ...
    async def point_mark(self, n: int) -> None: ...
    async def click_mark(self, n: int) -> bool: ...
    async def point_at(self, x_pct: float, y_pct: float) -> None: ...
    async def click_at(self, x_pct: float, y_pct: float) -> bool: ...
    def expired(self, now: float) -> bool: ...
    async def close(self) -> None: ...


Opener = Callable[[str], Awaitable[Display]]


class InvalidRoomError(ValueError):
    pass


class BusyError(RuntimeError):
    """Every screen slot is in use."""


class NotSharingError(LookupError):
    """The room has no AI screen right now."""


@dataclass
class _Entry:
    display: Display
    last_used: float
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class ScreenManager:
    def __init__(
        self,
        opener: Opener,
        guard: UrlGuard,
        *,
        presenter: str,
        max_sessions: int,
        idle_timeout_s: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._opener = opener
        self._guard = guard
        self._presenter = presenter
        self._max = max_sessions
        self._idle = idle_timeout_s
        self._clock = clock
        self._entries: dict[str, _Entry] = {}
        self._open_lock = asyncio.Lock()

    @property
    def count(self) -> int:
        return len(self._entries)

    async def _entry(self, room: str) -> _Entry:
        if not ROOM_RE.fullmatch(room):
            raise InvalidRoomError(room)
        async with self._open_lock:
            entry = self._entries.get(room)
            if entry and entry.display.expired(self._clock()):
                await self._drop(room)
                entry = None
            if entry is None:
                if len(self._entries) >= self._max:
                    raise BusyError
                entry = _Entry(display=await self._opener(room), last_used=self._clock())
                self._entries[room] = entry
            entry.last_used = self._clock()
            return entry

    async def show_url(self, room: str, url: str) -> None:
        url = await self._guard.check(url)
        entry = await self._entry(room)
        async with entry.lock:
            await entry.display.show_url(url)

    async def show_notes(self, room: str, notes: Notes) -> None:
        entry = await self._entry(room)
        async with entry.lock:
            await entry.display.show_html(render(notes, self._presenter))

    async def _existing(self, room: str) -> _Entry:
        entry = self._entries.get(room)
        if entry is None or entry.display.expired(self._clock()):
            raise NotSharingError(room)
        entry.last_used = self._clock()
        return entry

    async def snapshot(self, room: str) -> Snapshot:
        entry = await self._existing(room)
        async with entry.lock:
            return await entry.display.snapshot()

    async def scroll(self, room: str, direction: str) -> Snapshot:
        entry = await self._existing(room)
        async with entry.lock:
            await entry.display.scroll(direction)
            return await entry.display.snapshot()

    async def run(
        self, room: str, action: Callable[[Display], Awaitable[bool]]
    ) -> tuple[bool, Snapshot]:
        """Runs one cursor action on the room's screen: (whether it changed, what it shows)."""
        entry = await self._existing(room)
        async with entry.lock:
            changed = await action(entry.display)
            return changed, await entry.display.snapshot()

    async def point(self, room: str, text: str) -> Snapshot:
        """Moves the AI's cursor onto something and highlights it (the snapshot shows it)."""
        entry = await self._existing(room)
        async with entry.lock:
            await entry.display.point_text(text)
            return await entry.display.snapshot()

    async def click(self, room: str, text: str) -> tuple[bool, Snapshot]:
        """(whether the screen changed, what it shows now)."""
        entry = await self._existing(room)
        async with entry.lock:
            changed = await entry.display.click_text(text)
            return changed, await entry.display.snapshot()

    async def _drop(self, room: str) -> bool:
        entry = self._entries.pop(room, None)
        if entry is None:
            return False
        await entry.display.close()
        return True

    async def stop(self, room: str) -> bool:
        async with self._open_lock:
            return await self._drop(room)

    async def reap(self) -> int:
        """Closes screens nobody used for a while or whose room emptied or ended."""
        now = self._clock()
        async with self._open_lock:
            stale = [
                room
                for room, entry in self._entries.items()
                if now - entry.last_used >= self._idle or entry.display.expired(now)
            ]
            for room in stale:
                await self._drop(room)
        return len(stale)

    async def close_all(self) -> None:
        async with self._open_lock:
            for room in list(self._entries):
                await self._drop(room)
