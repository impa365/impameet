"""Internal HTTP API used by the voice agent (``meet-impar-screen``)."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hmac
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Literal

from aiohttp import web
from playwright.async_api import Error as PlaywrightError
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from .browser import BrowserPage, BrowserPool, Snapshot
from .config import Settings, load_settings
from .marks import MAX_MARKS
from .notes import MAX_POINTS, Notes
from .publisher import LiveKitScreen, screen_token
from .sessions import (
    BusyError,
    Display,
    InvalidRoomError,
    NotSharingError,
    ScreenManager,
)
from .urlguard import MAX_URL_LENGTH, BlockedURLError, UrlGuard

logger = logging.getLogger("meet_impar_screen")
MAX_BODY_BYTES = 64 * 1024
REAP_INTERVAL_S = 15.0
# A header name, not a credential.
TOKEN_HEADER = "X-Internal-Token"  # noqa: S105  # nosec B105
MANAGER: web.AppKey[ScreenManager] = web.AppKey("manager", ScreenManager)

Handler = Callable[[web.Request], Awaitable[web.StreamResponse]]


class ShareBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    url: str | None = Field(default=None, max_length=MAX_URL_LENGTH)
    title: str = Field(default="", max_length=1000)
    points: list[str] = Field(default_factory=list, max_length=MAX_POINTS * 4)


class ActionBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: Literal["scroll", "click", "point", "point_mark", "click_mark", "point_at", "click_at"]
    direction: Literal["up", "down"] = "down"
    text: str = Field(default="", max_length=200)
    # A numbered mark from the last capture, or a position on it in percent of each side.
    mark: int | None = Field(default=None, ge=1, le=MAX_MARKS)
    x: float | None = Field(default=None, ge=0, le=100)
    y: float | None = Field(default=None, ge=0, le=100)

    @model_validator(mode="after")
    def _target_is_given(self) -> ActionBody:
        if self.action in ("click", "point") and not self.text.strip():
            raise ValueError(f"{self.action} needs text")
        if self.action in ("point_mark", "click_mark") and self.mark is None:
            raise ValueError(f"{self.action} needs mark")
        if self.action in ("point_at", "click_at") and (self.x is None or self.y is None):
            raise ValueError(f"{self.action} needs x and y")
        return self


def _error(status: int, code: str, message: str) -> web.Response:
    return web.json_response({"error": code, "message": message}, status=status)


def _share_error(exc: Exception) -> web.Response:
    """Most specific first: InvalidRoomError and BlockedURLError are ValueErrors."""
    if isinstance(exc, InvalidRoomError):
        return _error(400, "invalid_room", "sala inválida")
    if isinstance(exc, BlockedURLError):
        return _error(400, "blocked_url", str(exc))
    if isinstance(exc, BusyError):
        return _error(429, "busy", "todas as telas da IA estão em uso")
    if isinstance(exc, PlaywrightError):
        return _error(502, "page_failed", "não foi possível abrir a página")
    return _error(400, "invalid_body", str(exc))


def build_app(manager: ScreenManager, token: str) -> web.Application:
    @web.middleware
    async def auth(request: web.Request, handler: Handler) -> web.StreamResponse:
        if request.path == "/health":
            return await handler(request)
        given = request.headers.get(TOKEN_HEADER, "")
        if not hmac.compare_digest(given.encode(), token.encode()):
            return _error(401, "unauthorized", "token inválido")
        return await handler(request)

    async def health(request: web.Request) -> web.Response:
        return web.json_response({"ok": True, "screens": request.app[MANAGER].count})

    async def share(request: web.Request) -> web.Response:
        room = request.match_info["room"]
        try:
            body = ShareBody.model_validate(await request.json())
        except (ValueError, ValidationError):
            return _error(400, "invalid_body", "envie url ou title/points")
        try:
            if body.url:
                await manager.show_url(room, body.url)
            else:
                await manager.show_notes(room, Notes.create(body.title, body.points))
        except (ValueError, BusyError, PlaywrightError) as exc:
            logger.info("share on %s refused: %s", room, type(exc).__name__)
            return _share_error(exc)
        logger.info("share on %s: %s", room, "page" if body.url else "topics")
        return web.json_response({"ok": True})

    async def stop(request: web.Request) -> web.Response:
        stopped = await manager.stop(request.match_info["room"])
        return web.json_response({"ok": True, "stopped": stopped})

    async def snapshot(request: web.Request) -> web.Response:
        try:
            shot = await manager.snapshot(request.match_info["room"])
        except NotSharingError:
            return _error(404, "not_sharing", "a IA não está mostrando nada agora")
        except PlaywrightError:
            return _error(502, "page_failed", "não foi possível ver a tela")
        return web.json_response(_snapshot_json(shot))

    async def act(request: web.Request) -> web.Response:
        room = request.match_info["room"]
        try:
            body = ActionBody.model_validate(await request.json())
        except (ValueError, ValidationError):
            return _error(400, "invalid_body", "envie action=scroll, click ou point (com text)")
        try:
            changed, shot = await _run_action(manager, room, body)
        except NotSharingError:
            return _error(404, "not_sharing", "a IA não está mostrando nada agora")
        except PlaywrightError as exc:
            logger.info("%s on %s failed: %s", body.action, room, str(exc).splitlines()[0][:200])
            return _error(422, "action_failed", "não encontrei isso na tela")
        logger.info(
            "%s on %s: changed=%s now=%s", body.action, room, changed, shot.url or shot.title
        )
        return web.json_response({**_snapshot_json(shot), "changed": changed})

    app = web.Application(middlewares=[auth], client_max_size=MAX_BODY_BYTES)
    app[MANAGER] = manager
    app.router.add_get("/health", health)
    app.router.add_post("/v1/rooms/{room}/screen", share)
    app.router.add_delete("/v1/rooms/{room}/screen", stop)
    app.router.add_get("/v1/rooms/{room}/screen/snapshot", snapshot)
    app.router.add_post("/v1/rooms/{room}/screen/action", act)
    return app


async def _run_action(manager: ScreenManager, room: str, body: ActionBody) -> tuple[bool, Snapshot]:
    """(whether the screen changed, what it shows now). Only clicks can fail to change it."""
    if body.action == "scroll":
        return True, await manager.scroll(room, body.direction)
    if body.action == "point":
        return True, await manager.point(room, body.text)
    if body.action == "click":
        return await manager.click(room, body.text)
    mark, x, y = body.mark or 0, body.x or 0.0, body.y or 0.0

    async def pointed(d: Display) -> bool:
        if body.action == "point_mark":
            await d.point_mark(mark)
        else:
            await d.point_at(x, y)
        return True

    if body.action in ("point_mark", "point_at"):
        return await manager.run(room, pointed)
    if body.action == "click_mark":
        return await manager.run(room, lambda d: d.click_mark(mark))
    return await manager.run(room, lambda d: d.click_at(x, y))


def quiet_stream_noise(record: logging.LogRecord) -> bool:
    """LiveKit logs every data stream nobody here listens to (once per second per agent)."""
    return not str(record.msg).startswith(("ignoring byte stream", "ignoring text stream"))


def _snapshot_json(shot: Snapshot) -> dict[str, object]:
    return {
        "image": base64.b64encode(shot.image).decode(),
        "title": shot.title,
        "url": shot.url,
        "text": shot.text,
        "marks": [m.as_json() for m in shot.marks],
    }


class RoomScreen:
    """A browser page wired to a LiveKit screen-share track."""

    def __init__(self, page: BrowserPage, screen: LiveKitScreen) -> None:
        self._page = page
        self._screen = screen

    async def show_url(self, url: str) -> None:
        await self._page.show_url(url)

    async def show_html(self, html: str) -> None:
        await self._page.show_html(html)

    async def snapshot(self) -> Snapshot:
        return await self._page.snapshot()

    async def scroll(self, direction: str) -> None:
        await self._page.scroll(direction)

    async def click_text(self, text: str) -> bool:
        return await self._page.click_text(text)

    async def point_text(self, text: str) -> None:
        await self._page.point_text(text)

    async def point_mark(self, n: int) -> None:
        await self._page.point_mark(n)

    async def click_mark(self, n: int) -> bool:
        return await self._page.click_mark(n)

    async def point_at(self, x_pct: float, y_pct: float) -> None:
        await self._page.point_at(x_pct, y_pct)

    async def click_at(self, x_pct: float, y_pct: float) -> bool:
        return await self._page.click_at(x_pct, y_pct)

    def expired(self, now: float) -> bool:
        return self._screen.expired(now)

    async def close(self) -> None:
        await self._page.close()
        await self._screen.close()


def make_opener(settings: Settings, pool: BrowserPool) -> Callable[[str], Awaitable[Display]]:
    async def open_room(room: str) -> Display:
        screen = LiveKitScreen(settings.width, settings.height)
        try:
            await screen.connect(str(settings.livekit_url), screen_token(settings, room))
            page = await pool.open_page(screen.push_jpeg)
        except BaseException:
            await screen.close()
            raise
        return RoomScreen(page, screen)

    return open_room


async def _reaper(manager: ScreenManager) -> None:
    while True:
        await asyncio.sleep(REAP_INTERVAL_S)
        with contextlib.suppress(Exception):
            if closed := await manager.reap():
                logger.info("closed %d idle screen(s)", closed)


def create_service(settings: Settings) -> web.Application:
    guard = UrlGuard()
    pool = BrowserPool(guard, settings.width, settings.height)
    manager = ScreenManager(
        make_opener(settings, pool),
        guard,
        presenter=settings.display_name,
        max_sessions=settings.max_sessions,
        idle_timeout_s=settings.idle_timeout_s,
    )
    app = build_app(manager, settings.token.get_secret_value())

    async def lifecycle(_: web.Application) -> AsyncIterator[None]:
        await pool.start()
        reaper = asyncio.create_task(_reaper(manager))
        yield
        reaper.cancel()
        await manager.close_all()
        await pool.close()

    app.cleanup_ctx.append(lifecycle)
    return app


def run() -> None:  # pragma: no cover - process entry point, exercised by the container e2e
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    logging.getLogger().addFilter(quiet_stream_noise)
    settings = load_settings()
    web.run_app(create_service(settings), port=settings.port, access_log=None)
