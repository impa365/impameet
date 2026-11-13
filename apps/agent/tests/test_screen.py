from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
from pydantic import SecretStr

from meet_impar_agent import main
from meet_impar_agent.config import ScreenSettings, load_settings
from meet_impar_agent.screen import (
    CLICK_DID_NOTHING,
    SCREEN_INSTRUCTIONS,
    Mark,
    ScreenClient,
    Snapshot,
    _snapshot,
    screen_tools,
)

from .test_main import profile

SETTINGS = ScreenSettings(url="http://screen:8090/", token=SecretStr("screen-secret"))  # type: ignore[arg-type]
SHOT = {
    "image": "aW1n",
    "title": "Preços",
    "url": "https://example.com/",
    "text": "Plano Pro R$ 99",
}


class Recorder:
    """Fake screen service: records requests and answers by path."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.status: dict[str, int] = {}
        self.body: dict[str, Any] = {}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path.rsplit("/screen", 1)[1] or "/"
        status = self.status.get(path, 200)
        body = self.body.get(path, SHOT if path in ("/snapshot", "/action") else {"ok": True})
        if isinstance(body, str):
            return httpx.Response(status, text=body)
        return httpx.Response(status, json=body)


class FakeViewer:
    def __init__(self) -> None:
        self.seen: list[Snapshot] = []
        self.posted: list[str] = []

    async def see(self, snapshot: Snapshot) -> None:
        self.seen.append(snapshot)

    async def post_text(self, text: str) -> None:
        self.posted.append(text)


def client(recorder: Recorder) -> ScreenClient:
    return ScreenClient(SETTINGS, "t1.sala de vendas", transport=httpx.MockTransport(recorder))


def tools_for(rec: Recorder, viewer: FakeViewer) -> dict[str, Any]:
    return {t.info.name: t for t in screen_tools(client(rec), viewer)}


async def test_showing_a_page_lets_the_agent_see_it() -> None:
    rec, viewer = Recorder(), FakeViewer()
    tools = tools_for(rec, viewer)
    answer = await tools["mostrar_pagina"]("https://example.com")

    assert "A página está na tela" in answer
    assert "Título: Preços" in answer
    assert "Plano Pro R$ 99" in answer
    assert viewer.seen == [Snapshot("aW1n", "Preços", "https://example.com/", "Plano Pro R$ 99")]
    show, look = rec.requests
    assert (show.method, str(show.url)) == (
        "POST",
        "http://screen:8090/v1/rooms/t1.sala%20de%20vendas/screen",
    )
    assert show.headers["x-internal-token"] == "screen-secret"
    assert json.loads(show.content) == {"url": "https://example.com"}
    assert look.method == "GET"
    assert look.url.path == "/v1/rooms/t1.sala de vendas/screen/snapshot"


async def test_topics_scroll_click_and_look() -> None:
    rec, viewer = Recorder(), FakeViewer()
    tools = tools_for(rec, viewer)
    assert "Os tópicos estão na tela" in await tools["mostrar_topicos"]("Plano", ["um", "dois"])
    # The pixels on screen have a readable twin in the chat.
    assert viewer.posted == ["[Na tela] Plano\n• um\n• dois"]
    assert "Rolei" in await tools["rolar_tela"]("baixo")
    await tools["rolar_tela"]("cima")
    assert "Cliquei" in await tools["clicar_na_tela"]("Preços")
    assert "Esta é a tela agora" in await tools["ver_tela"]()
    assert await tools["parar_de_mostrar"]() == "Parei de mostrar a tela."

    bodies = [json.loads(r.content) if r.content else None for r in rec.requests]
    assert bodies == [
        {"title": "Plano", "points": ["um", "dois"]},
        None,
        {"action": "scroll", "direction": "down"},
        {"action": "scroll", "direction": "up"},
        {"action": "click", "text": "Preços"},
        None,
        None,
    ]
    assert len(viewer.seen) == 5


MARKS = [
    {"n": 1, "kind": "ícone", "label": "", "x": 40, "y": 40, "width": 48, "height": 48},
    {"n": 2, "kind": "gráfico", "label": "Vendas 2026", "x": 380, "y": 40, "width": 200},
    {"n": "x", "kind": "lixo"},
    "nada",
]


def test_marks_reach_the_model_as_a_short_list() -> None:
    shot = _snapshot({**SHOT, "marks": MARKS})
    assert shot.marks == (Mark(1, "ícone", ""), Mark(2, "gráfico", "Vendas 2026"))
    assert shot.describe().endswith('Marcas numeradas na imagem: 1 ícone; 2 gráfico "Vendas 2026".')
    assert "Marcas" not in _snapshot({**SHOT, "marks": "bad"}).describe()
    many = _snapshot({**SHOT, "marks": [{"n": i, "kind": "link"} for i in range(1, 200)]})
    assert len(many.marks) == 60


@pytest.mark.parametrize(
    ("tool", "args", "body", "done"),
    [
        ("apontar_marca", (2,), {"action": "point_mark", "mark": 2}, "Seu cursor está ali."),
        ("clicar_marca", (1,), {"action": "click_mark", "mark": 1}, "Cliquei."),
        (
            "apontar_posicao",
            (62.5, 30),
            {"action": "point_at", "x": 62.5, "y": 30},
            "Seu cursor está nesse ponto.",
        ),
        (
            "clicar_posicao",
            (10, 90),
            {"action": "click_at", "x": 10, "y": 90},
            "Cliquei nesse ponto.",
        ),
    ],
)
async def test_pointing_and_clicking_without_text(
    tool: str, args: tuple[Any, ...], body: dict[str, Any], done: str
) -> None:
    rec, viewer = Recorder(), FakeViewer()
    rec.body["/action"] = {**SHOT, "marks": MARKS}
    answer = await tools_for(rec, viewer)[tool](*args)
    assert answer.startswith(done)
    assert "Marcas numeradas na imagem" in answer
    assert json.loads(rec.requests[0].content) == body
    assert len(viewer.seen) == 1


async def test_a_mark_click_that_changes_nothing_is_reported() -> None:
    rec, viewer = Recorder(), FakeViewer()
    rec.body["/action"] = {**SHOT, "changed": False}
    assert (await tools_for(rec, viewer)["clicar_marca"](3)).startswith(CLICK_DID_NOTHING)
    rec.status["/action"] = 422
    rec.body["/action"] = {"error": "action_failed", "message": "não encontrei isso na tela"}
    assert "não encontrei" in await tools_for(rec, viewer)["apontar_marca"](9)


def test_instructions_explain_marks_and_positions() -> None:
    assert "apontar_marca" in SCREEN_INSTRUCTIONS
    assert "de 0 a 100" in SCREEN_INSTRUCTIONS


async def test_pointing_moves_the_cursor_and_lets_the_agent_see_it() -> None:
    rec, viewer = Recorder(), FakeViewer()
    answer = await tools_for(rec, viewer)["apontar_na_tela"]("Plano Pro")
    assert answer.startswith("Seu cursor está apontando para isso.")
    assert json.loads(rec.requests[0].content) == {"action": "point", "text": "Plano Pro"}
    assert len(viewer.seen) == 1


async def test_a_click_that_changes_nothing_is_reported_to_the_model() -> None:
    rec, viewer = Recorder(), FakeViewer()
    rec.body["/action"] = {**SHOT, "changed": False}
    tools = tools_for(rec, viewer)
    answer = await tools["clicar_na_tela"]("Saiba mais")
    assert answer.startswith(CLICK_DID_NOTHING)
    assert len(viewer.seen) == 1
    rec.body["/action"] = {**SHOT, "changed": True}
    assert (await tools["clicar_na_tela"]("Entrar")).startswith("Cliquei.")


async def test_failures_become_sentences_and_nothing_is_seen() -> None:
    rec, viewer = Recorder(), FakeViewer()
    rec.status["/"] = 400
    rec.body["/"] = {"error": "blocked_url", "message": "endereço fora da internet pública"}
    tools = tools_for(rec, viewer)
    answer = await tools["mostrar_pagina"]("http://intranet/")
    assert answer.startswith("Não foi possível")
    assert "pública" in answer

    rec.status["/action"] = 422
    rec.body["/action"] = "not json"
    assert "422" in await tools["clicar_na_tela"]("nada")
    rec.status["/snapshot"] = 404
    rec.body["/snapshot"] = ["x"]
    assert "404" in await tools["ver_tela"]()
    rec.status["/"] = 502
    rec.body["/"] = {"error": "page_failed"}
    assert "502" in await tools["mostrar_topicos"]("T", ["a"])
    assert "502" in await tools["parar_de_mostrar"]()
    assert viewer.seen == []


async def test_closing_stops_an_active_share_only() -> None:
    rec = Recorder()
    screen = client(rec)
    await screen.aclose()
    assert rec.requests == []

    rec = Recorder()
    screen = client(rec)
    await screen.show_page("https://example.com")
    assert screen.sharing
    await screen.aclose()
    assert rec.requests[-1].method == "DELETE"


async def test_unreachable_service_does_not_raise() -> None:
    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    screen = ScreenClient(SETTINGS, "r", transport=httpx.MockTransport(down))
    assert "não respondeu" in await screen.stop()


def test_snapshot_description_is_bounded() -> None:
    shot = Snapshot("x", "", "", "a" * 5000)
    assert shot.describe() == "Texto visível na tela: " + "a" * 1500
    assert "(nenhum texto)" in Snapshot("x", "T", "u", "").describe()


def test_agent_gets_screen_tools_only_when_the_service_is_configured(
    env: dict[str, str],
) -> None:
    ctx = MagicMock()
    ctx.room.name = "t1.sala"
    session = MagicMock()
    plain = main._build_agent(ctx, load_settings(env), profile(mute_policy="disabled"), session)
    assert [t.info.name for t in plain.tools] == ["passar_a_vez"]
    ctx.add_shutdown_callback.assert_not_called()

    with_screen = load_settings(env | {"SCREEN_URL": "http://screen:8090", "SCREEN_TOKEN": "tk"})
    agent = main._build_agent(ctx, with_screen, profile(instructions="Seja breve."), session)
    assert {t.info.name for t in agent.tools} == {
        "passar_a_vez",
        "mostrar_pagina",
        "mostrar_topicos",
        "ver_tela",
        "rolar_tela",
        "clicar_na_tela",
        "apontar_na_tela",
        "apontar_marca",
        "clicar_marca",
        "apontar_posicao",
        "clicar_posicao",
        "parar_de_mostrar",
        "silenciar_voz",
        "ativar_voz",
    }
    assert agent.instructions.startswith("Seja breve.\n\n")
    assert SCREEN_INSTRUCTIONS in agent.instructions
    ctx.add_shutdown_callback.assert_called_once()
    assert "tk" in with_screen.secret_values()


async def test_mute_changes_are_announced_to_the_room(env: dict[str, str]) -> None:
    ctx = MagicMock()
    ctx.room.local_participant.set_attributes = AsyncMock()
    agent = main._build_agent(ctx, load_settings(env), profile(), MagicMock())
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(type(agent), "update_instructions", AsyncMock())
        await agent.set_muted(True)
        await agent.set_muted(False)
    calls = ctx.room.local_participant.set_attributes.await_args_list
    assert [c.args[0] for c in calls] == [{"impa.muted": "true"}, {"impa.muted": ""}]
