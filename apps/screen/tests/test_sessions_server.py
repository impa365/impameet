from __future__ import annotations

import asyncio
from typing import Any

import pytest
from aiohttp.test_utils import TestClient
from playwright.async_api import Error as PlaywrightError

from meet_impar_screen import server
from meet_impar_screen.browser import Snapshot
from meet_impar_screen.marks import Mark
from meet_impar_screen.notes import Notes
from meet_impar_screen.server import build_app
from meet_impar_screen.sessions import BusyError, InvalidRoomError, ScreenManager
from meet_impar_screen.urlguard import BlockedURLError, UrlGuard

ROOM = "4f0c.vendas"
TOKEN = "t0ken-for-tests"


class FakeDisplay:
    def __init__(self, room: str) -> None:
        self.room = room
        self.shown: list[str] = []
        self.closed = False
        self.dead = False
        self.fail: Exception | None = None

    async def show_url(self, url: str) -> None:
        if self.fail:
            raise self.fail
        self.shown.append(f"url:{url}")

    async def show_html(self, html: str) -> None:
        self.shown.append(f"html:{html}")

    async def snapshot(self) -> Snapshot:
        if self.fail:
            raise self.fail
        return Snapshot(
            image=b"\xff\xd8jpeg",
            title="Título",
            url="https://example.com/",
            text="olá",
            marks=(Mark(1, "ícone", "", 10, 20, 24, 24),),
        )

    async def scroll(self, direction: str) -> None:
        self.shown.append(f"scroll:{direction}")

    async def click_text(self, text: str) -> bool:
        if text == "nada":
            raise PlaywrightError("Timeout")
        self.shown.append(f"click:{text}")
        return text != "rótulo"

    async def point_text(self, text: str) -> None:
        if text == "nada":
            raise PlaywrightError("not found")
        self.shown.append(f"point:{text}")

    async def point_mark(self, n: int) -> None:
        if n == 9:
            raise PlaywrightError("mark 9 is gone")
        self.shown.append(f"point_mark:{n}")

    async def click_mark(self, n: int) -> bool:
        self.shown.append(f"click_mark:{n}")
        return n != 2

    async def point_at(self, x_pct: float, y_pct: float) -> None:
        self.shown.append(f"point_at:{x_pct},{y_pct}")

    async def click_at(self, x_pct: float, y_pct: float) -> bool:
        self.shown.append(f"click_at:{x_pct},{y_pct}")
        return True

    def expired(self, now: float) -> bool:
        return self.dead

    async def close(self) -> None:
        self.closed = True


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


async def public(host: str) -> list[str]:
    return ["93.184.215.14"] if host == "example.com" else ["10.0.0.1"]


@pytest.fixture
def opened() -> list[FakeDisplay]:
    return []


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def manager(opened: list[FakeDisplay], clock: Clock) -> ScreenManager:
    async def opener(room: str) -> FakeDisplay:
        display = FakeDisplay(room)
        opened.append(display)
        return display

    return ScreenManager(
        opener,
        UrlGuard(public),
        presenter="Kaiser",
        max_sessions=2,
        idle_timeout_s=60,
        clock=clock,
    )


class TestManager:
    async def test_reuses_one_screen_per_room(
        self, manager: ScreenManager, opened: list[FakeDisplay]
    ) -> None:
        await manager.show_url(ROOM, "https://example.com/a")
        await manager.show_notes(ROOM, Notes.create("Resumo", ["um"]))
        assert len(opened) == 1
        assert opened[0].shown[0] == "url:https://example.com/a"
        assert "Resumo" in opened[0].shown[1]
        assert "Kaiser" in opened[0].shown[1]
        assert manager.count == 1

    async def test_validates_before_opening(
        self, manager: ScreenManager, opened: list[FakeDisplay]
    ) -> None:
        with pytest.raises(BlockedURLError):
            await manager.show_url(ROOM, "http://intranet/")
        with pytest.raises(InvalidRoomError):
            await manager.show_url("../x y", "https://example.com/")
        assert opened == []

    async def test_limits_concurrent_screens(self, manager: ScreenManager) -> None:
        await manager.show_url("a", "https://example.com/")
        await manager.show_url("b", "https://example.com/")
        with pytest.raises(BusyError):
            await manager.show_url("c", "https://example.com/")
        assert await manager.stop("a")
        assert not await manager.stop("a")
        await manager.show_url("c", "https://example.com/")

    async def test_reaps_idle_and_abandoned_screens(
        self, manager: ScreenManager, opened: list[FakeDisplay], clock: Clock
    ) -> None:
        await manager.show_url("a", "https://example.com/")
        await manager.show_url("b", "https://example.com/")
        assert await manager.reap() == 0
        opened[1].dead = True
        assert await manager.reap() == 1
        clock.now += 61
        assert await manager.reap() == 1
        assert all(d.closed for d in opened)
        assert manager.count == 0

    async def test_replaces_a_screen_whose_room_ended(
        self, manager: ScreenManager, opened: list[FakeDisplay]
    ) -> None:
        await manager.show_url(ROOM, "https://example.com/")
        opened[0].dead = True
        await manager.show_url(ROOM, "https://example.com/b")
        assert len(opened) == 2
        assert opened[0].closed
        assert opened[1].shown == ["url:https://example.com/b"]

    async def test_background_reaper(
        self,
        manager: ScreenManager,
        opened: list[FakeDisplay],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setattr(server, "REAP_INTERVAL_S", 0.01)
        await manager.show_url("a", "https://example.com/")
        opened[0].dead = True
        task = asyncio.create_task(server._reaper(manager))
        for _ in range(200):
            if opened[0].closed:
                break
            await asyncio.sleep(0.01)
        task.cancel()
        assert opened[0].closed

    async def test_close_all(self, manager: ScreenManager, opened: list[FakeDisplay]) -> None:
        await manager.show_url("a", "https://example.com/")
        await manager.close_all()
        assert opened[0].closed
        assert manager.count == 0


@pytest.fixture
async def client(aiohttp_client: Any, manager: ScreenManager) -> TestClient:  # type: ignore[type-arg]
    return await aiohttp_client(build_app(manager, TOKEN))  # type: ignore[no-any-return]


H = {"X-Internal-Token": TOKEN}


class TestServer:
    async def test_health_is_public(self, client: TestClient) -> None:  # type: ignore[type-arg]
        res = await client.get("/health")
        assert res.status == 200
        assert await res.json() == {"ok": True, "screens": 0}

    @pytest.mark.parametrize("headers", [{}, {"X-Internal-Token": "wrong"}])
    async def test_requires_the_token(
        self,
        client: TestClient,  # type: ignore[type-arg]
        headers: dict[str, str],
    ) -> None:
        res = await client.post(f"/v1/rooms/{ROOM}/screen", json={"url": "x"}, headers=headers)
        assert res.status == 401
        assert (await client.delete(f"/v1/rooms/{ROOM}/screen", headers=headers)).status == 401

    async def test_shares_pages_and_notes_then_stops(
        self,
        client: TestClient,  # type: ignore[type-arg]
        opened: list[FakeDisplay],
    ) -> None:
        res = await client.post(
            f"/v1/rooms/{ROOM}/screen", json={"url": "https://example.com/"}, headers=H
        )
        assert (res.status, await res.json()) == (200, {"ok": True})
        res = await client.post(
            f"/v1/rooms/{ROOM}/screen", json={"title": "Plano", "points": ["a"]}, headers=H
        )
        assert res.status == 200
        assert len(opened[0].shown) == 2
        res = await client.delete(f"/v1/rooms/{ROOM}/screen", headers=H)
        assert await res.json() == {"ok": True, "stopped": True}

    @pytest.mark.parametrize(
        ("room", "body", "status", "code"),
        [
            (ROOM, "not json", 400, "invalid_body"),
            (ROOM, {"url": "https://example.com", "extra": 1}, 400, "invalid_body"),
            (ROOM, {"title": " ", "points": []}, 400, "invalid_body"),
            (ROOM, {"url": "http://intranet/"}, 400, "blocked_url"),
            ("bad room!", {"url": "https://example.com/"}, 400, "invalid_room"),
        ],
    )
    async def test_rejects_bad_requests(
        self,
        client: TestClient,  # type: ignore[type-arg]
        room: str,
        body: Any,
        status: int,
        code: str,
    ) -> None:
        kwargs = {"data": body} if isinstance(body, str) else {"json": body}
        res = await client.post(f"/v1/rooms/{room}/screen", headers=H, **kwargs)
        assert res.status == status
        assert (await res.json())["error"] == code

    async def test_busy_and_page_failures(
        self,
        client: TestClient,  # type: ignore[type-arg]
        opened: list[FakeDisplay],
    ) -> None:
        for room in ("a", "b"):
            await client.post(
                f"/v1/rooms/{room}/screen", json={"url": "https://example.com/"}, headers=H
            )
        res = await client.post(
            "/v1/rooms/c/screen", json={"url": "https://example.com/"}, headers=H
        )
        assert (res.status, (await res.json())["error"]) == (429, "busy")
        opened[0].fail = PlaywrightError("net::ERR_NAME_NOT_RESOLVED")
        res = await client.post(
            "/v1/rooms/a/screen", json={"url": "https://example.com/"}, headers=H
        )
        assert (res.status, (await res.json())["error"]) == (502, "page_failed")

    async def test_the_agent_sees_scrolls_and_clicks_what_it_shows(
        self,
        client: TestClient,  # type: ignore[type-arg]
        opened: list[FakeDisplay],
    ) -> None:
        base = f"/v1/rooms/{ROOM}/screen"
        res = await client.get(f"{base}/snapshot", headers=H)
        assert (res.status, (await res.json())["error"]) == (404, "not_sharing")
        await client.post(base, json={"url": "https://example.com/"}, headers=H)

        res = await client.get(f"{base}/snapshot", headers=H)
        assert await res.json() == {
            "image": "/9hqcGVn",
            "title": "Título",
            "url": "https://example.com/",
            "text": "olá",
            "marks": [
                {"n": 1, "kind": "ícone", "label": "", "x": 10, "y": 20, "width": 24, "height": 24}
            ],
        }
        res = await client.post(
            f"{base}/action", json={"action": "click", "text": "rótulo"}, headers=H
        )
        assert (await res.json())["changed"] is False
        res = await client.post(f"{base}/action", json={"action": "scroll"}, headers=H)
        assert res.status == 200
        res = await client.post(
            f"{base}/action", json={"action": "click", "text": "Preços"}, headers=H
        )
        assert res.status == 200
        assert opened[0].shown[-2:] == ["scroll:down", "click:Preços"]

        res = await client.post(
            f"{base}/action", json={"action": "point", "text": "Pro"}, headers=H
        )
        assert (res.status, (await res.json())["title"]) == (200, "Título")
        assert opened[0].shown[-1] == "point:Pro"
        res = await client.post(
            f"{base}/action", json={"action": "point", "text": "nada"}, headers=H
        )
        assert res.status == 422
        res = await client.post(f"{base}/action", json={"action": "point"}, headers=H)
        assert res.status == 400

        res = await client.post(
            f"{base}/action", json={"action": "click", "text": "nada"}, headers=H
        )
        assert (res.status, (await res.json())["error"]) == (422, "action_failed")
        for bad in (
            {"action": "click"},
            {"action": "zoom"},
            {"action": "scroll", "direction": "x"},
        ):
            res = await client.post(f"{base}/action", json=bad, headers=H)
            assert res.status == 400
        opened[0].fail = PlaywrightError("crashed")
        assert (await client.get(f"{base}/snapshot", headers=H)).status == 502
        opened[0].dead = True
        res = await client.post(f"{base}/action", json={"action": "scroll"}, headers=H)
        assert res.status == 404
        assert (await client.get(f"{base}/snapshot")).status == 401

    @pytest.mark.parametrize(
        ("body", "expected", "changed"),
        [
            ({"action": "point_mark", "mark": 3}, "point_mark:3", True),
            ({"action": "click_mark", "mark": 4}, "click_mark:4", True),
            ({"action": "click_mark", "mark": 2}, "click_mark:2", False),
            ({"action": "point_at", "x": 25, "y": 75.5}, "point_at:25.0,75.5", True),
            ({"action": "click_at", "x": 0, "y": 100}, "click_at:0.0,100.0", True),
        ],
    )
    async def test_points_and_clicks_without_text(
        self,
        client: TestClient,  # type: ignore[type-arg]
        opened: list[FakeDisplay],
        body: dict[str, Any],
        expected: str,
        changed: bool,
    ) -> None:
        base = f"/v1/rooms/{ROOM}/screen"
        await client.post(base, json={"url": "https://example.com/"}, headers=H)
        res = await client.post(f"{base}/action", json=body, headers=H)
        data = await res.json()
        assert res.status == 200
        assert data["changed"] is changed
        assert data["marks"][0]["kind"] == "ícone"
        assert opened[0].shown[-1] == expected

    @pytest.mark.parametrize(
        "body",
        [
            {"action": "point_mark"},
            {"action": "click_mark", "mark": 0},
            {"action": "point_mark", "mark": 61},
            {"action": "point_at", "x": 50},
            {"action": "click_at", "x": 50, "y": 101},
            {"action": "point_at", "x": -1, "y": 5},
        ],
    )
    async def test_rejects_incomplete_targets(
        self,
        client: TestClient,  # type: ignore[type-arg]
        body: dict[str, Any],
    ) -> None:
        base = f"/v1/rooms/{ROOM}/screen"
        await client.post(base, json={"url": "https://example.com/"}, headers=H)
        assert (await client.post(f"{base}/action", json=body, headers=H)).status == 400

    async def test_a_stale_mark_is_reported(
        self,
        client: TestClient,  # type: ignore[type-arg]
    ) -> None:
        base = f"/v1/rooms/{ROOM}/screen"
        await client.post(base, json={"url": "https://example.com/"}, headers=H)
        res = await client.post(
            f"{base}/action", json={"action": "point_mark", "mark": 9}, headers=H
        )
        assert (res.status, (await res.json())["error"]) == (422, "action_failed")

    async def test_rejects_oversized_bodies(self, client: TestClient) -> None:  # type: ignore[type-arg]
        res = await client.post(f"/v1/rooms/{ROOM}/screen", data="x" * (70 * 1024), headers=H)
        assert res.status == 413
