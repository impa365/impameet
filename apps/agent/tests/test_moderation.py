from __future__ import annotations

import json
from typing import Any
from unittest.mock import MagicMock

import httpx
from livekit import rtc
from livekit.agents import stt
from pydantic import SecretStr

from meet_impar_agent import main
from meet_impar_agent.config import PlatformSettings, load_settings
from meet_impar_agent.moderation import (
    KNOCK_PROMPT,
    Heard,
    ModerationClient,
    Person,
    find,
    moderation_note,
    moderation_tools,
)
from meet_impar_agent.persona import Talker, VoiceAgent
from meet_impar_agent.profile import AgentProfile, clean_rules, clean_tools, profile_from_platform

from .test_agent_credentials import REMOTE

PLATFORM = PlatformSettings(url="http://platform:3000", token=SecretStr("tok"))  # type: ignore[arg-type]
BASE = "/api/internal/agents/ag-1/moderation"

ANA = Talker(name="Ana", role="moderator", identity="u-ana")
BIA = Talker(name="Bia", role="guest", identity="g-bia")

VIEW = {
    "people": [
        {"identity": "u-ana", "name": "Ana", "role": "moderator", "micOn": True, "protected": True},
        {"identity": "g-jose", "name": "José Silva", "role": "guest", "micOn": True},
        {"identity": "g-joao", "name": "João Lima", "role": "guest", "micOn": False},
        {"identity": "g-joao2", "name": "João Souza", "role": "guest", "micOn": True},
    ],
    "lobby": [{"id": "l1", "name": "Carla"}, {"id": "l2", "name": "Davi"}],
}


class Platform:
    """A fake moderation API that records what the agent asked for."""

    def __init__(self, answer: int = 200) -> None:
        self.posts: list[dict[str, Any]] = []
        self.answer = answer

    def __call__(self, request: httpx.Request) -> httpx.Response:
        assert request.url.path == BASE
        assert request.headers["x-internal-token"] == "tok"
        if request.method == "GET":
            assert request.url.params["room"] == "t1.sala"
            return httpx.Response(200, json=VIEW)
        body = json.loads(request.content)
        self.posts.append(body)
        if self.answer != 200:
            return httpx.Response(self.answer, json={"error": {"message": "Sem permissão"}})
        return httpx.Response(200, json={"done": f"{body['target']} ok"})


class Host:
    def __init__(self, speaker: Talker | None = None) -> None:
        self.speaker = speaker
        self.heard: Heard | None = None

    def current_speaker(self) -> Talker | None:
        return self.speaker

    def last_heard(self) -> Heard | None:
        return self.heard


class Clock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


def client(platform: Any) -> ModerationClient:
    transport = httpx.MockTransport(platform)
    return ModerationClient(
        PLATFORM, "ag-1", "t1.sala", client=httpx.AsyncClient(transport=transport)
    )


def tools(
    platform: Any,
    host: Host,
    enabled: tuple[str, ...] = ("remove", "mute", "lobby"),
    *,
    has_rules: bool = False,
    clock: Clock | None = None,
) -> dict[str, Any]:
    made = moderation_tools(
        client(platform), host, enabled, has_rules=has_rules, clock=clock or Clock()
    )
    return {t.info.name: t for t in made}


def test_find_prefers_the_whole_name_then_the_first_name_then_part_of_it() -> None:
    people = [Person(**{**p, "mic_on": True, "protected": False}) for p in _people()]
    assert [p.name for p in find("josé silva", people)] == ["José Silva"]
    assert [p.name for p in find("Jose", people)] == ["José Silva"]
    assert [p.name for p in find("joão", people)] == ["João Lima", "João Souza"]
    assert [p.name for p in find("souza", people)] == ["João Souza"]
    assert find("", people) == []
    assert find("Zé", people) == []


def _people() -> list[dict[str, str]]:
    return [
        {"identity": p["identity"], "name": p["name"], "role": p["role"]} for p in VIEW["people"]
    ]


def test_only_the_tools_an_admin_turned_on_are_offered() -> None:
    assert set(tools(Platform(), Host(), ("mute",))) == {
        "ver_participantes",
        "silenciar_participante",
    }
    assert clean_tools(["lobby", "nuke", "remove", "lobby"]) == ("remove", "lobby")
    assert clean_tools("remove") == ()
    assert clean_rules("  regra  ") == "regra"
    assert clean_rules(None) == ""
    assert len(clean_rules("x" * 9000)) == 4000


def test_the_note_lists_the_tools_and_the_admin_rules() -> None:
    assert moderation_note((), "x") == ""
    note = moderation_note(("remove",), "")
    assert "remover_participante" in note
    assert "silenciar_participante" not in note
    assert "REGRAS DO ADMINISTRADOR" not in note
    ruled = moderation_note(("mute", "lobby"), "Silencie quem fizer barulho.")
    assert ruled.endswith(
        "REGRAS DO ADMINISTRADOR (siga-as mesmo sem pedirem):\nSilencie quem fizer barulho."
    )


async def test_the_list_shows_roles_mics_protection_and_the_waiting_room() -> None:
    seen = await tools(Platform(), Host())["ver_participantes"]()
    assert "- Ana (moderator, microfone ligado) [protegido]" in seen
    assert "- João Lima (guest, microfone desligado)" in seen
    assert "Na sala de espera:\n- Carla\n- Davi" in seen
    without_lobby = await tools(Platform(), Host(), ("mute",))["ver_participantes"]()
    assert "sala de espera" not in without_lobby

    def down(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    assert "Não consegui ver" in await tools(down, Host())["ver_participantes"]()


async def test_nobody_but_a_moderator_or_a_rule_can_make_it_act() -> None:
    platform = Platform()
    guest = tools(platform, Host(BIA))
    assert "Só posso fazer isso" in await guest["silenciar_participante"]("José")
    assert "Só posso fazer isso" in await guest["silenciar_participante"]("José", regra="inventei")
    assert platform.posts == []

    ruled = tools(platform, Host(BIA), has_rules=True)
    assert await ruled["silenciar_participante"]("José", regra="Silencie quem fizer barulho") == (
        "Feito: g-jose ok."
    )
    assert platform.posts == [
        {
            "room": "t1.sala",
            "action": "mute",
            "target": "g-jose",
            "rule": "Silencie quem fizer barulho",
        }
    ]


async def test_a_moderator_mutes_by_name_and_the_platform_has_the_last_word() -> None:
    platform = Platform()
    mute = tools(platform, Host(ANA))["silenciar_participante"]
    assert await mute("josé") == "Feito: g-jose ok."
    assert platform.posts[-1] == {
        "room": "t1.sala",
        "action": "mute",
        "target": "g-jose",
        "requestedBy": "u-ana",
    }
    assert "não posso agir" in await mute("Ana")
    assert "mais de uma pessoa" in (await mute("João")).lower()
    assert "Não encontrei Zé" in await mute("Zé")
    assert len(platform.posts) == 1

    refused = tools(Platform(answer=403), Host(ANA))["silenciar_participante"]
    assert await refused("José") == "Não foi possível: Sem permissão."


async def test_removing_waits_for_the_same_moderator_to_say_yes() -> None:
    platform, host, clock = Platform(), Host(ANA), Clock()
    remove = tools(platform, host, clock=clock)["remover_participante"]

    assert "Quer mesmo que eu remova José Silva da chamada?" in await remove("José")
    assert platform.posts == []

    host.heard = Heard(at=clock.now + 1, text="Sim, não quero", identity="u-ana", role="moderator")
    assert "Quer mesmo" in await remove("José")  # "não" in the answer: ask again
    host.heard = Heard(at=clock.now + 1, text="pode", identity="g-bia", role="guest")
    assert "Quer mesmo" in await remove("José")  # someone else said yes
    assert platform.posts == []

    clock.now += 5
    host.heard = Heard(at=clock.now, text="Sim, pode remover", identity="u-ana", role="moderator")
    clock.now += 1
    assert await remove("José") == "Feito: g-jose ok."
    assert platform.posts == [
        {"room": "t1.sala", "action": "remove", "target": "g-jose", "requestedBy": "u-ana"}
    ]
    assert "Quer mesmo" in await remove("José")  # each removal is confirmed on its own


async def test_a_confirmation_goes_stale() -> None:
    platform, host, clock = Platform(), Host(ANA), Clock()
    remove = tools(platform, host, clock=clock)["remover_participante"]
    await remove("José")
    host.heard = Heard(at=clock.now + 1, text="sim", identity="u-ana", role="moderator")
    clock.now += 120
    assert "Quer mesmo" in await remove("José")
    assert platform.posts == []


async def test_an_admin_rule_removes_without_asking() -> None:
    platform = Platform()
    remove = tools(platform, Host(), has_rules=True)["remover_participante"]
    assert await remove("José", regra="Remova quem ofender") == "Feito: g-jose ok."
    assert platform.posts[0]["rule"] == "Remova quem ofender"


async def test_the_waiting_room_one_by_one_or_everyone() -> None:
    platform = Platform()
    lobby = tools(platform, Host(ANA))["responder_sala_de_espera"]
    assert await lobby("carla", aprovar=True) == "Feito: l1 ok."
    assert await lobby("todo mundo", aprovar=False) == "Feito: l1 ok. Feito: l2 ok."
    assert [(p["action"], p["target"]) for p in platform.posts] == [
        ("admit", "l1"),
        ("deny", "l1"),
        ("deny", "l2"),
    ]
    assert await lobby("Eva", aprovar=True) == "Na sala de espera estão: Carla, Davi."


async def test_a_platform_that_is_down_gets_a_spoken_answer() -> None:
    def down(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    answer = await tools(down, Host(ANA))["silenciar_participante"]("José")
    assert answer.startswith("Não consegui falar com o servidor")


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


def test_the_profile_reads_the_admin_choices() -> None:
    remote = REMOTE | {
        "id": "ag-1",
        "moderationTools": ["mute", "remove"],
        "moderationRules": "  Silencie quem fizer barulho.  ",
    }
    p = profile_from_platform(remote)
    assert p is not None
    assert (p.agent_id, p.moderation_tools) == ("ag-1", ("remove", "mute"))
    assert p.moderation_rules == "Silencie quem fizer barulho."
    plain = profile_from_platform({k: v for k, v in remote.items() if "oderation" not in k})
    assert plain is not None
    assert plain.moderation_tools == ()
    assert plain.moderation_rules == ""


def test_the_agent_hears_who_said_what_and_offers_the_tools() -> None:
    agent = VoiceAgent(
        profile(moderation_tools=("remove",), moderation_rules="Remova quem ofender."),
        speaker=lambda: ANA,
        moderation=client(Platform()),
    )
    names = {t.info.name for t in agent.tools}
    assert {"ver_participantes", "remover_participante"} <= names
    assert "silenciar_participante" not in names
    assert "REGRAS DO ADMINISTRADOR" in agent.instructions
    assert agent.current_speaker() == ANA
    assert agent.last_heard() is None

    final = stt.SpeechEvent(
        type=stt.SpeechEventType.FINAL_TRANSCRIPT,
        alternatives=[stt.SpeechData(language="pt", text="pode remover")],
    )
    agent.label_event(final)
    heard = agent.last_heard()
    assert heard is not None
    assert (heard.text, heard.identity) == ("pode remover", "u-ana")

    without_client = VoiceAgent(profile(moderation_tools=("remove",)))
    assert "remover_participante" not in {t.info.name for t in without_client.tools}


def test_a_knock_makes_only_a_lobby_agent_speak() -> None:
    session = MagicMock()
    lobby_agent = VoiceAgent(profile(moderation_tools=("lobby",)), moderation=client(Platform()))
    mute_agent = VoiceAgent(profile(moderation_tools=("mute",)), moderation=client(Platform()))
    original = VoiceAgent.session
    try:
        VoiceAgent.session = property(lambda _self: session)  # type: ignore[assignment,method-assign]
        mute_agent.on_lobby_knock()
        session.generate_reply.assert_not_called()
        lobby_agent.on_lobby_knock()
        session.generate_reply.assert_called_once_with(instructions=KNOCK_PROMPT)
        session.generate_reply.side_effect = RuntimeError("closing")
        lobby_agent.on_lobby_knock()
    finally:
        VoiceAgent.session = original  # type: ignore[method-assign]


def test_the_room_relays_server_knocks_to_the_agent() -> None:
    room = MagicMock()
    agent = MagicMock()
    main.follow_lobby(room, agent)
    (event, on_data), _ = room.on.call_args
    assert event == "data_received"

    from_person = MagicMock(topic="impa.lobby", participant=MagicMock())
    on_data(from_person)
    on_data(MagicMock(spec=rtc.DataPacket, topic="impa.chat", participant=None))
    agent.on_lobby_knock.assert_not_called()
    on_data(MagicMock(spec=rtc.DataPacket, topic="impa.lobby", participant=None))
    agent.on_lobby_knock.assert_called_once()


def test_the_agent_gets_a_moderation_client_only_with_the_platform_and_tools(
    env: dict[str, str],
) -> None:
    ctx = MagicMock()
    ctx.room.name = "t1.sala"
    session = MagicMock()
    with_platform = load_settings(
        env | {"PLATFORM_URL": "http://platform:3000", "PLATFORM_TOKEN": "t" * 40}
    )

    off = main._build_agent(ctx, with_platform, profile(agent_id="ag-1"), session)
    assert "ver_participantes" not in {t.info.name for t in off.tools}
    ctx.add_shutdown_callback.assert_not_called()

    on = main._build_agent(
        ctx, with_platform, profile(agent_id="ag-1", moderation_tools=("mute",)), session
    )
    assert {"ver_participantes", "silenciar_participante"} <= {t.info.name for t in on.tools}
    ctx.add_shutdown_callback.assert_called_once()

    no_platform = main._build_agent(
        MagicMock(),
        load_settings(env),
        profile(agent_id="ag-1", moderation_tools=("mute",)),
        session,
    )
    assert "ver_participantes" not in {t.info.name for t in no_platform.tools}
