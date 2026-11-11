from __future__ import annotations

import asyncio
from collections.abc import Iterator
from dataclasses import replace
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
from livekit import rtc
from pydantic import SecretStr

from meet_impar_agent import main
from meet_impar_agent.chat import CHAT_INSTRUCTIONS, CHAT_TOPIC, follow_chat
from meet_impar_agent.config import PlatformSettings
from meet_impar_agent.knowledge import KNOWLEDGE_NOTE, KnowledgeClient
from meet_impar_agent.persona import VoiceAgent
from meet_impar_agent.profile import AgentProfile

from .conftest import TUNING

PLATFORM = PlatformSettings(url="http://platform:3000", token=SecretStr("tok"))  # type: ignore[arg-type]


def profile(**overrides: Any) -> AgentProfile:
    base: dict[str, Any] = {
        "name": "Kaiser",
        "instructions": "Você é o Kaiser.",
        "greeting": "",
        "voice_id": "voz",
        "tts_model": "s2.1-pro",
        "llm_model": "m",
        "voices": {"pt": "voz"},
        "agent_id": "ag-1",
    }
    return AgentProfile(**(TUNING | base | overrides))


def person(identity: str, name: str, role: str, *, agent: bool = False) -> MagicMock:
    p = MagicMock()
    p.identity, p.name, p.attributes = identity, name, {"role": role}
    p.kind = (
        rtc.ParticipantKind.PARTICIPANT_KIND_AGENT
        if agent
        else rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD
    )
    return p


def reader(text: str) -> MagicMock:
    r = MagicMock()
    r.read_all = AsyncMock(return_value=text)
    return r


async def settle() -> None:
    for _ in range(5):
        await asyncio.sleep(0)


async def test_everyone_in_the_room_is_read_but_not_other_assistants() -> None:
    room = MagicMock()
    room.remote_participants = {
        "g-abrantes": person("g-abrantes", "Abrantes", "guest"),
        "u-lorran": person("u-lorran", "Lorran", "moderator"),
        "ag-ana": person("ag-ana", "Ana", "participant", agent=True),
    }
    got: list[tuple[str, str, str, str]] = []

    async def on_message(identity: str, name: str, role: str, text: str) -> None:
        got.append((identity, name, role, text))

    follow_chat(room, on_message)
    topic, handler = room.register_text_stream_handler.call_args.args
    assert topic == CHAT_TOPIC
    handler(reader("  https://youtu.be/xyz  "), "g-abrantes")
    handler(reader("eu também"), "u-lorran")
    handler(reader("sou outra IA"), "ag-ana")
    handler(reader("fantasma"), "ninguem")
    handler(reader("   "), "u-lorran")
    await settle()
    assert got == [
        ("g-abrantes", "Abrantes", "guest", "https://youtu.be/xyz"),
        ("u-lorran", "Lorran", "moderator", "eu também"),
    ]

    # A broken stream or a failing answer is one lost message, never a crash.
    broken = MagicMock()
    broken.read_all = AsyncMock(side_effect=RuntimeError("stream"))
    handler(broken, "u-lorran")

    async def failing(*_: str) -> None:
        raise RuntimeError("boom")

    follow_chat(room, failing)
    room.register_text_stream_handler.call_args.args[1](reader("oi"), "u-lorran")
    await settle()


@pytest.fixture
def live() -> Iterator[tuple[VoiceAgent, MagicMock, list[tuple[str, str]]]]:
    heard: list[tuple[str, str]] = []
    agent = VoiceAgent(profile(), hearing=lambda who, text: heard.append((who.name, text)))
    session = MagicMock()
    type(agent).session = property(lambda self: session)  # type: ignore[method-assign]
    try:
        yield agent, session, heard
    finally:
        del type(agent).session


async def test_chat_messages_are_answered_with_who_wrote_them(
    live: tuple[VoiceAgent, MagicMock, list[tuple[str, str]]],
) -> None:
    agent, session, heard = live
    assert CHAT_INSTRUCTIONS in agent.instructions
    await agent.on_chat("g-abrantes", "Abrantes", "guest", "Abre esse link: https://youtu.be/xyz")
    session.generate_reply.assert_called_once_with(
        user_input="Abrantes (convidado) no chat: Abre esse link: https://youtu.be/xyz"
    )
    assert heard == [("Abrantes", "[chat] Abre esse link: https://youtu.be/xyz")]
    assert [a.name for a in agent.turn_authors()] == ["Abrantes"]


async def test_a_quiet_agent_only_answers_chat_that_names_it(
    live: tuple[VoiceAgent, MagicMock, list[tuple[str, str]]],
) -> None:
    agent, session, _ = live
    agent.muted = True
    await agent.on_chat("u-lorran", "Lorran", "moderator", "galera, intervalo de 5 min")
    session.generate_reply.assert_not_called()
    texts = [m.text_content for m in agent.chat_ctx.items if hasattr(m, "text_content")]
    assert "Lorran (moderador) no chat: galera, intervalo de 5 min" in texts
    await agent.on_chat("u-lorran", "Lorran", "moderator", "Kaíser, volta a falar")
    session.generate_reply.assert_called_once()


async def test_admin_changes_reach_the_agent_during_the_meeting() -> None:
    agent = VoiceAgent(profile())
    assert KNOWLEDGE_NOTE not in agent.instructions
    assert "consultar_base_de_conhecimento" not in {t.id for t in agent.tools}
    assert await agent.apply_profile(profile(), None) is False

    client = KnowledgeClient(
        PLATFORM,
        "ag-1",
        "t1.sala",
        client=httpx.AsyncClient(
            transport=httpx.MockTransport(lambda _r: httpx.Response(200, json={"hits": []}))
        ),
    )
    changed = profile(
        instructions="Você é o Kaiser, professor.", style_rules="Seja breve.", knowledge_bases=1
    )
    assert await agent.apply_profile(changed, client) is True
    assert agent.instructions.startswith("Você é o Kaiser, professor.\n\nREGRAS DE ESTILO")
    assert KNOWLEDGE_NOTE in agent.instructions
    assert "consultar_base_de_conhecimento" in {t.id for t in agent.tools}

    assert await agent.apply_profile(replace(changed, knowledge_bases=0), None) is True
    assert KNOWLEDGE_NOTE not in agent.instructions
    assert "consultar_base_de_conhecimento" not in {t.id for t in agent.tools}
    await client.aclose()


async def test_the_live_agent_picks_up_a_base_linked_after_it_joined(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent = VoiceAgent(profile())
    fresh = [profile(knowledge_bases=1), None]

    async def load(_settings: Any, _metadata: Any) -> AgentProfile | None:
        if not fresh:
            raise asyncio.CancelledError
        return fresh.pop(0)

    monkeypatch.setattr(main, "load_profile", load)
    monkeypatch.setattr(main, "PROFILE_REFRESH_S", 0)
    ctx = MagicMock()
    ctx.room.name = "t1.sala"
    settings = MagicMock()
    settings.platform = PLATFORM
    main.follow_profile(ctx, settings, agent, None)
    for _ in range(30):
        await asyncio.sleep(0)
    assert "consultar_base_de_conhecimento" in {t.id for t in agent.tools}
    ctx.add_shutdown_callback.assert_called_once()
