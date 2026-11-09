from __future__ import annotations

import asyncio
import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from livekit import rtc

from meet_impar_agent import main
from meet_impar_agent.config import load_settings
from meet_impar_agent.perception import (
    ACTIONS_OFF,
    BOARD_TOPIC,
    POLICY_TOPIC,
    POLLS_TOPIC,
    Board,
    Perception,
    Polls,
    perception_note,
    perception_tools,
    sharers,
)
from meet_impar_agent.persona import VoiceAgent
from meet_impar_agent.profile import (
    AgentProfile,
    agent_actions,
    board_policy,
    clean_perception,
    profile_from_platform,
)

from .test_agent_credentials import REMOTE


async def settle() -> None:
    """Lets the background tasks the room callbacks started run to the end."""
    for _ in range(10):
        await asyncio.sleep(0)


def el(eid: str, kind: str, version: int = 1, nonce: int = 5, **extra: Any) -> dict[str, Any]:
    return {"id": eid, "type": kind, "version": version, "versionNonce": nonce, **extra}


def scene(*elements: dict[str, Any]) -> str:
    return json.dumps({"type": "scene", "elements": list(elements)})


def test_the_board_merges_like_excalidraw_and_honours_who_may_draw() -> None:
    board = Board(policy="moderators")
    assert board.apply(scene(el("a", "rectangle")), "Eva", "guest") is False
    assert board.apply(scene(el("a", "rectangle")), "Ana", "moderator") is True
    # older version, or same version with a higher nonce: ignored
    assert board.apply(scene(el("a", "ellipse", version=0)), "Ana", "moderator") is False
    assert board.apply(scene(el("a", "ellipse", nonce=9)), "Ana", "moderator") is False
    assert board.apply(scene(el("a", "ellipse", nonce=1)), "Ana", "moderator") is True
    assert board.elements["a"]["type"] == "ellipse"
    for bad in ("not json", json.dumps({"type": "request"}), json.dumps([1]), scene({"id": 3})):
        assert board.apply(bad, "Ana", "moderator") is False
    assert board.apply("x" * 2_000_001, "Ana", "moderator") is False
    board.policy = "everyone"
    assert board.apply(scene(el("b", "text", text="oi")), "Eva", "guest") is True


def test_the_board_is_described_with_texts_arrows_positions_and_authors() -> None:
    board = Board()
    assert board.describe() == "O quadro está vazio."
    board.apply(
        scene(
            el("box", "rectangle", x=0, y=0, width=100, height=50),
            el("label", "text", text="Vendas", containerId="box", x=10, y=10),
            el("goal", "ellipse", x=900, y=600, width=100, height=100),
            el(
                "arrow",
                "arrow",
                x=100,
                y=25,
                width=800,
                height=600,
                startBinding={"elementId": "box"},
                endBinding={"elementId": "goal"},
            ),
            el("photo", "image", x=450, y=300, width=100, height=50),
            el("gone", "diamond", isDeleted=True),
        ),
        "Ana",
        "moderator",
    )
    board.apply(scene(el("note", "text", text="Meta: 10%", x=0, y=640, height=20)), "Bia", "guest")
    text = board.describe()
    assert text.startswith("O quadro tem 5 elementos (feito por Ana, Bia).")
    assert "- retângulo “Vendas”, em cima, à esquerda, por Ana" in text
    assert "seta ligando retângulo “Vendas” a elipse, " in text
    assert "elipse, embaixo, à direita, por Ana" in text
    assert "imagem (sem descrição), no centro, por Ana" in text
    assert "texto “Meta: 10%”, embaixo, à esquerda, por Bia" in text
    assert "losango" not in text

    many = Board()
    many.apply(scene(*(el(f"e{i}", "line", x=i) for i in range(70))), "Ana", "moderator")
    assert many.describe().endswith("… e mais 10.")
    one = Board()
    one.apply(scene(el("only", "freedraw")), "Ana", "moderator")
    assert (
        one.describe()
        == "O quadro tem 1 elemento (feito por Ana).\n- desenho à mão livre, no centro, por Ana"
    )


def poll_msg(**poll: Any) -> str:
    base = {
        "id": "p1",
        "question": "Pizza ou sushi?",
        "options": ["Pizza", "Sushi"],
        "byName": "Ana",
    }
    return json.dumps({"type": "poll", "poll": base | poll})


def test_polls_count_votes_once_per_person_and_never_say_who_voted() -> None:
    polls = Polls()
    assert polls.describe() == "Não há enquetes nesta reunião."
    polls.apply(poll_msg(), "u-ana")
    polls.apply(poll_msg(question="duplicada"), "u-bia")  # same id: ignored
    polls.apply(json.dumps({"type": "vote", "pollId": "p1", "option": 0}), "u-bia")
    polls.apply(json.dumps({"type": "vote", "pollId": "p1", "option": 1}), "u-bia")  # changed mind
    polls.apply(json.dumps({"type": "vote", "pollId": "p1", "option": 1}), "g-eva")
    polls.apply(json.dumps({"type": "vote", "pollId": "p1", "option": 7}), "g-caio")
    polls.apply(json.dumps({"type": "vote", "pollId": "nope", "option": 0}), "g-caio")
    polls.apply(json.dumps({"type": "close", "pollId": "p1"}), "u-bia")  # not the creator
    assert polls.polls[0]["closed"] is False
    polls.apply(json.dumps({"type": "close", "pollId": "p1"}), "u-ana")
    polls.apply(json.dumps({"type": "vote", "pollId": "p1", "option": 0}), "g-late")  # closed
    polls.apply(poll_msg(id="bad", options=["só uma"]), "u-ana")
    polls.apply("not json", "u-ana")
    text = polls.describe()
    assert (
        "“Pizza ou sushi?” (encerrada, criada por Ana, 2 votos) → Pizza: 0 votos; Sushi: 2 votos"
        in text
    )
    assert "eva" not in text.lower()
    assert "bia" not in text.lower()


def test_late_joiners_adopt_what_the_browsers_already_know() -> None:
    polls = Polls()
    polls.apply(poll_msg(), "u-ana")
    polls.apply(json.dumps({"type": "vote", "pollId": "p1", "option": 0}), "u-bia")
    state = {
        "polls": [
            {
                "id": "p1",
                "question": "Pizza ou sushi?",
                "options": ["Pizza", "Sushi"],
                "closed": True,
            },
            {
                "id": "p2",
                "question": "Hoje?",
                "options": ["Sim", "Não"],
                "by": "u-caio",
                "closed": False,
            },
            {"id": "x", "question": "", "options": []},
        ],
        "votes": {
            "p1": {"u-bia": 1, "g-eva": 1},
            "p2": {"u-caio": 0, "g-bad": 9},
            "ghost": {"a": 0},
            "p3": "nope",
        },
    }
    polls.apply(json.dumps({"type": "state", "state": state}), "u-caio")
    assert polls.polls[0]["closed"] is True
    assert polls.votes["p1"] == {"u-bia": 0, "g-eva": 1}  # what we saw first is kept
    assert polls.votes["p2"] == {"u-caio": 0}
    assert [p["id"] for p in polls.polls] == ["p1", "p2"]
    polls.apply(json.dumps({"type": "state", "state": {"polls": "x", "votes": []}}), "u-caio")


class Pub:
    def __init__(self, source: Any, kind: Any = rtc.TrackKind.KIND_VIDEO) -> None:
        self.source = source
        self.kind = kind
        self.track = object()


def participant(identity: str, name: str, *pubs: Pub, agent: bool = False, role: str = "") -> Any:
    p = MagicMock()
    p.identity = identity
    p.name = name
    p.attributes = {"role": role} if role else {}
    p.kind = (
        rtc.ParticipantKind.PARTICIPANT_KIND_AGENT
        if agent
        else rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD
    )
    p.track_publications = {str(i): pub for i, pub in enumerate(pubs)}
    return p


class Host:
    def __init__(self) -> None:
        self.actions = True
        self.images: list[tuple[str, str]] = []

    def actions_allowed(self) -> bool:
        return self.actions

    async def show_image(self, label: str, image_b64: str) -> None:
        self.images.append((label, image_b64))


def view_with(*people: Any, allowed: tuple[str, ...] = ("board", "polls", "screen")) -> Perception:
    room = MagicMock()
    room.remote_participants = {p.identity: p for p in people}

    async def grab(_pub: Any) -> str:
        return "aW1n"

    return Perception(room, allowed, grab=grab)


async def test_the_agent_looks_at_a_shared_screen_only_when_asked_and_says_whose() -> None:
    screen = Pub(rtc.TrackSource.SOURCE_SCREENSHARE)
    ana = participant("u-ana", "Ana", Pub(rtc.TrackSource.SOURCE_CAMERA), screen)
    bot = participant("agent-1", "Tela IA", Pub(rtc.TrackSource.SOURCE_SCREENSHARE), agent=True)
    view = view_with(ana, bot)
    assert [s.name for s in sharers(view.room)] == ["Ana"]
    host = Host()
    tools = {t.info.name: t for t in perception_tools(view, host)}
    assert set(tools) == {"ver_quadro", "ver_enquetes", "ver_tela_compartilhada"}

    answer = await tools["ver_tela_compartilhada"]()
    assert answer.startswith("A imagem da tela de Ana está na conversa")
    assert host.images == [("[Tela compartilhada por Ana, agora]", "aW1n")]
    assert "não está compartilhando" in await tools["ver_tela_compartilhada"]("Bia")

    bia = participant("u-bia", "Bia Souza", Pub(rtc.TrackSource.SOURCE_SCREENSHARE))
    ana2 = participant("u-ana2", "Bia Lima", Pub(rtc.TrackSource.SOURCE_SCREENSHARE))
    two = view_with(bia, ana2)
    pick = {t.info.name: t for t in perception_tools(two, host)}["ver_tela_compartilhada"]
    assert "Pergunte de quem" in await pick()
    assert "Pergunte de quem" in await pick("Bia")
    assert "tela de Bia Lima" in await pick("Bia Lima")

    nobody = view_with(participant("u-x", "X", Pub(rtc.TrackSource.SOURCE_CAMERA)))
    empty = {t.info.name: t for t in perception_tools(nobody, host)}["ver_tela_compartilhada"]
    assert await empty() == "Ninguém está compartilhando a tela agora."

    async def broken(_pub: Any) -> str:
        raise TimeoutError

    view.grab = broken
    assert "Não consegui ver a tela de Ana" in await tools["ver_tela_compartilhada"]()


async def test_moderators_can_take_the_ai_eyes_away_and_admins_choose_what_it_sees() -> None:
    view = view_with()
    view.board.apply(scene(el("a", "text", text="oi")), "Ana", "moderator")
    host = Host()
    tools = {t.info.name: t for t in perception_tools(view, host)}
    assert "oi" in await tools["ver_quadro"]()
    assert await tools["ver_enquetes"]() == "Não há enquetes nesta reunião."
    host.actions = False
    for tool in tools.values():
        assert await tool() == ACTIONS_OFF

    only_board = view_with(allowed=("board",))
    assert [t.info.name for t in perception_tools(only_board, host)] == ["ver_quadro"]
    assert "ver_quadro" in perception_note(("board",))
    assert "ver_tela_compartilhada" not in perception_note(("board",))
    assert perception_note(()) == ""


def test_messages_reach_only_what_the_admin_allowed() -> None:
    ana = participant("u-ana", "Ana", role="moderator")
    eva = participant("g-eva", "Eva", role="guest")
    view = view_with(ana, eva, allowed=("board",))
    view.board.policy = "moderators"
    view.on_board(scene(el("a", "rectangle")), "g-eva")
    view.on_board(scene(el("b", "rectangle")), "u-ana")
    view.on_board(scene(el("c", "rectangle")), "u-gone")  # left: unknown role, not a moderator
    assert list(view.board.elements) == ["b"]
    view.on_polls(poll_msg(), "u-ana")
    assert view.polls.polls == []  # polls not allowed for this agent
    view.on_policy(json.dumps({"board": "everyone", "polls": "everyone"}).encode())
    assert view.board.policy == "everyone"
    view.on_policy(b"{bad")
    view.on_policy(json.dumps({"board": "nobody"}).encode())
    assert view.board.policy == "everyone"


def test_the_profile_and_dispatch_carry_the_choices() -> None:
    assert clean_perception(["screen", "board", "x", "board"]) == ("board", "screen")
    assert clean_perception("board") == ()
    p = profile_from_platform(REMOTE | {"perception": ["polls"]})
    assert p is not None
    assert p.perception == ("polls",)
    assert agent_actions(json.dumps({"agentActions": False})) is False
    assert agent_actions(None) is True
    assert board_policy(json.dumps({"boardPolicy": "moderators"})) == "moderators"
    assert board_policy(json.dumps({"boardPolicy": "x"})) == "everyone"


def profile(**overrides: Any) -> AgentProfile:
    base: dict[str, Any] = {
        "name": "Kaiser",
        "instructions": "x",
        "greeting": "",
        "voice_id": None,
        "tts_model": "s2.1-pro",
        "llm_model": "m",
        "stt_model": "transcribe-stream-1",
        "llm_base_url": "https://llm.example.com/v1",
        "llm_api_key": "sk-test-0123456789",
        "tts_api_key": "fish-test-0123456789",
        "stt_api_key": "fish-test-0123456789",
        "voices": {"pt": "voz-kaiser"},
        "mute_policy": "disabled",
    }
    return AgentProfile(**(base | overrides))


async def test_the_agent_builds_its_eyes_and_follows_the_room(env: dict[str, str]) -> None:
    ctx = MagicMock()
    ctx.room.name = "t1.sala"
    ctx.room.remote_participants = {}
    ctx.job.metadata = json.dumps({"agentActions": False, "boardPolicy": "moderators"})
    agent = main._build_agent(
        ctx, load_settings(env), profile(perception=("board", "polls")), MagicMock()
    )
    assert agent.perception is not None
    assert agent.perception.board.policy == "moderators"
    assert agent.actions_allowed() is False
    assert "AÇÕES DA IA" in agent.instructions
    assert {"ver_quadro", "ver_enquetes"} <= {t.id for t in agent.tools}

    agent.update_instructions = AsyncMock()  # type: ignore[method-assign]
    room = MagicMock()
    room.local_participant.send_text = AsyncMock()
    handlers: dict[str, Any] = {}
    room.register_text_stream_handler.side_effect = handlers.__setitem__
    main.follow_agent_settings(room, agent)
    await main.follow_meeting(room, agent.perception)
    assert set(handlers) == {BOARD_TOPIC, POLLS_TOPIC}
    sent = [c.kwargs["topic"] for c in room.local_participant.send_text.call_args_list]
    assert sent == [BOARD_TOPIC, POLLS_TOPIC]

    data_handlers = [c.args[1] for c in room.on.call_args_list if c.args[0] == "data_received"]
    settings = main.AGENT_SETTINGS_TOPIC
    for on_data in data_handlers:
        on_data(MagicMock(topic=settings, participant=None, data=b'{"agentActions": true}'))
        on_data(MagicMock(topic=POLICY_TOPIC, participant=None, data=b'{"board": "everyone"}'))
        on_data(MagicMock(topic=settings, participant=MagicMock(), data=b'{"agentActions": false}'))
    await settle()
    assert agent.actions_allowed() is True
    assert agent.perception.board.policy == "everyone"

    reader = MagicMock()
    reader.read_all = AsyncMock(return_value=scene(el("a", "text", text="Olá")))
    handlers[BOARD_TOPIC](reader, "u-nobody")
    await settle()
    assert "Olá" in agent.perception.board.describe()

    plain = main._build_agent(ctx, load_settings(env), profile(), MagicMock())
    assert plain.perception is None


@pytest.mark.parametrize("allowed", [("screen",)])
async def test_screen_only_needs_no_streams(allowed: tuple[str, ...]) -> None:
    room = MagicMock()
    room.local_participant.send_text = AsyncMock()
    await main.follow_meeting(room, Perception(room, allowed))
    room.register_text_stream_handler.assert_not_called()


async def test_show_image_keeps_one_image_in_the_conversation() -> None:
    agent = VoiceAgent(profile())
    agent.update_chat_ctx = AsyncMock(  # type: ignore[method-assign]
        side_effect=lambda ctx: setattr(agent, "_chat_ctx", ctx)
    )
    await agent.show_image("[Tela compartilhada por Ana, agora]", "aW1n")
    await agent.show_image("[Tela compartilhada por Bia, agora]", "aW1n")
    last = agent.update_chat_ctx.await_args.args[0]
    labels = [m.content[0] for m in last.items if getattr(m, "content", None)]
    assert labels == ["[Tela compartilhada por Bia, agora]"]
