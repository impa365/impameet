from __future__ import annotations

import logging
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from livekit import rtc
from livekit.agents import StopResponse, llm

from meet_impar_agent import main, redaction
from meet_impar_agent.config import load_settings
from meet_impar_agent.persona import Talker, VoiceAgent
from meet_impar_agent.profile import MAX_DISPLAY_NAME_LENGTH, AgentProfile, display_name

from .conftest import LIVEKIT_KEY, LIVEKIT_SECRET


def profile(**overrides: Any) -> AgentProfile:
    base = {
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
    }
    return AgentProfile(**(base | overrides))


@pytest.fixture
def process_env(env: dict[str, str], monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    return env


def test_server_uses_configured_credentials_and_explicit_dispatch(
    process_env: dict[str, str],
) -> None:
    server = main.build_server(load_settings(process_env))

    assert server._ws_url == "wss://livekit.example.com"
    assert server._api_key == LIVEKIT_KEY
    assert server._api_secret == LIVEKIT_SECRET
    assert server._agent_name == "kaiser"
    assert server.setup_fnc is main.prewarm


def test_prewarm_loads_vad_once_per_process(process_env: dict[str, str]) -> None:
    proc = MagicMock(userdata={})

    main.prewarm(proc)

    assert "vad" in proc.userdata
    assert redaction._installed_pattern is not None


class FakeSession:
    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs
        self.usage = "usage"
        self.handlers: dict[str, Any] = {}
        self.start = AsyncMock()
        self.room_io = MagicMock(linked_participant=None)

    def on(self, event: str) -> Any:
        def register(fn: Any) -> Any:
            self.handlers[event] = fn
            return fn

        return register


async def test_entrypoint_wires_the_pipeline_into_the_room(
    process_env: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    sessions: list[FakeSession] = []
    monkeypatch.setattr(
        main, "AgentSession", lambda **kw: sessions.append(FakeSession(**kw)) or sessions[-1]
    )
    thinking_audio = MagicMock(start=AsyncMock(), aclose=AsyncMock())
    monkeypatch.setattr(main, "build_thinking_audio", lambda _agent, **_: thinking_audio)
    monkeypatch.setattr(
        main, "load_profile", AsyncMock(return_value=profile(voice_id="voz-kaiser"))
    )

    ctx = MagicMock()
    ctx.room.name = "sala-1"
    ctx.room.local_participant.set_attributes = AsyncMock()
    ctx.job.metadata = ""
    ctx.proc.userdata = {"vad": "vad-instance"}

    await main.entrypoint(ctx)
    ctx.room.local_participant.set_attributes.assert_awaited_once_with({"impa.mode": "voice"})

    session = sessions[0]
    created = session.kwargs
    assert created["vad"] == "vad-instance"
    assert created["max_tool_steps"] == main.MAX_TOOL_STEPS
    assert created["turn_handling"]["turn_detection"] == "stt"
    assert ctx.log_context_fields == {"room": "sala-1", "agent": "Kaiser"}

    session.start.assert_awaited_once()
    kwargs = session.start.await_args.kwargs
    assert kwargs["room"] is ctx.room
    assert kwargs["record"] is False
    assert isinstance(kwargs["agent"], VoiceAgent)
    assert [c.args[0] for c in ctx.room.on.call_args_list] == [
        "active_speakers_changed",
        "participant_connected",
        "participant_disconnected",
        "participant_attributes_changed",
        "data_received",  # someone knocked on the waiting room
        "data_received",  # the room's typing-sound switch, applied live
    ]
    assert ctx.room.register_text_stream_handler.call_args.args[0] == main.HANDOFF_TOPIC

    assert set(session.handlers) == {"conversation_item_added", "error", "close"}
    assert created["conn_options"].llm_conn_options.timeout == pytest.approx(15)

    thinking_audio.start.assert_awaited_once_with(room=ctx.room, agent_session=session)
    callbacks = [c.args[0] for c in ctx.add_shutdown_callback.call_args_list]
    assert thinking_audio.aclose in callbacks
    await callbacks[0]()


async def test_entrypoint_applies_the_room_agent_profile(
    process_env: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    sessions: list[FakeSession] = []
    monkeypatch.setattr(
        main, "AgentSession", lambda **kw: sessions.append(FakeSession(**kw)) or sessions[-1]
    )
    monkeypatch.setattr(main, "build_thinking_audio", lambda _agent, **_: None)
    chosen = profile(name="Ana", voice_id="voz-ana", tts_model="drama-3", llm_model="qwen")
    monkeypatch.setattr(main, "load_profile", AsyncMock(return_value=chosen))
    ctx = MagicMock()
    ctx.job.metadata = '{"agentId": "a1"}'
    ctx.room.local_participant.set_attributes = AsyncMock()
    ctx.proc.userdata = {"vad": "vad"}

    await main.entrypoint(ctx)

    created = sessions[0].kwargs
    assert created["tts"]._opts.voice_id == "voz-ana"
    assert created["tts"]._opts.model == "drama-3"
    assert created["llm"].model == "qwen"
    assert ctx.log_context_fields["agent"] == "Ana"


def test_run_starts_the_cli(process_env: dict[str, str], monkeypatch: pytest.MonkeyPatch) -> None:
    run_app = MagicMock()
    monkeypatch.setattr(main.cli, "run_app", run_app)

    main.run()

    run_app.assert_called_once()
    assert run_app.call_args.args[0]._agent_name == "kaiser"


def participant(identity: str, role: str = "participant", agent: bool = False) -> MagicMock:
    kind = (
        rtc.ParticipantKind.PARTICIPANT_KIND_AGENT
        if agent
        else rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD
    )
    return MagicMock(identity=identity, attributes={"role": role}, kind=kind)


def room_with(*remote: MagicMock) -> MagicMock:
    room = MagicMock()
    room.local_participant.identity = "agent-self"
    room.remote_participants = {p.identity: p for p in remote}
    return room


class TestFollowSpeakers:
    def test_everyone_mode_follows_whoever_talks(self) -> None:
        guest = participant("g-1", "guest")
        room = room_with(guest)
        session = MagicMock()
        session.room_io.linked_participant = participant("u-mod", "moderator")

        main.follow_speakers(room, session, "everyone")
        session.room_io.set_participant.assert_not_called()
        relink = room.on.call_args.args[1]

        relink([participant("agent-self", agent=True), guest])
        session.room_io.set_participant.assert_called_once_with("g-1")

    def test_keeps_the_current_speaker_and_ignores_agents(self) -> None:
        room = room_with()
        session = MagicMock()
        session.room_io.linked_participant = participant("u-1")
        main.follow_speakers(room, session, "everyone")
        relink = room.on.call_args.args[1]

        relink([participant("u-1"), participant("u-2")])
        relink([participant("kaiser", agent=True)])
        relink([])
        session.room_io.set_participant.assert_not_called()

    def test_moderators_mode_links_a_moderator_from_the_start(self) -> None:
        room = room_with(participant("g-1", "guest"), participant("u-mod", "moderator"))
        session = MagicMock()
        session.room_io.linked_participant = None

        main.follow_speakers(room, session, "moderators")

        session.room_io.set_participant.assert_called_once_with("u-mod")
        relink = room.on.call_args.args[1]
        relink([participant("g-1", "guest")])
        assert session.room_io.set_participant.call_count == 1

    def test_participants_without_a_role_attribute_count_as_participants(self) -> None:
        room = room_with()
        session = MagicMock()
        session.room_io.linked_participant = None
        main.follow_speakers(room, session, "members")
        relink = room.on.call_args.args[1]
        p = MagicMock(
            identity="u-9", attributes=None, kind=rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD
        )

        relink([p])

        session.room_io.set_participant.assert_called_once_with("u-9")


def test_stream_noise_is_dropped_from_logs() -> None:
    def record(msg: str) -> logging.LogRecord:
        return logging.LogRecord("root", logging.INFO, "", 0, msg, None, None)

    assert not main.quiet_stream_noise(record("ignoring byte stream with topic 'lk.agent.session'"))
    assert not main.quiet_stream_noise(record("ignoring text stream with topic 'impa.captions'"))
    assert main.quiet_stream_noise(record("agent turn"))


class TestSpeakerLookup:
    def test_names_the_linked_participant_with_their_role(self) -> None:
        session = MagicMock()
        session.room_io.linked_participant = MagicMock(
            identity="u-1", attributes={"role": "moderator"}
        )
        session.room_io.linked_participant.name = "Nil"
        assert main.speaker_lookup(session)() == Talker("Nil", "moderator", identity="u-1")

        session.room_io.linked_participant = MagicMock(identity="g-7", attributes=None)
        session.room_io.linked_participant.name = ""
        assert main.speaker_lookup(session)() == Talker("g-7", "participant", identity="g-7")

    def test_nobody_before_start_or_when_unlinked(self) -> None:
        session = MagicMock()
        session.room_io.linked_participant = None
        assert main.speaker_lookup(session)() is None
        broken = MagicMock()
        type(broken).room_io = property(lambda _s: (_ for _ in ()).throw(RuntimeError("no io")))
        assert main.speaker_lookup(broken)() is None


def mock_session(agent: VoiceAgent) -> tuple[pytest.MonkeyPatch, MagicMock]:
    session = MagicMock()
    mp = pytest.MonkeyPatch()
    mp.setattr(VoiceAgent, "session", property(lambda _self: session))
    return mp, session


async def test_greeting_is_spoken_on_enter() -> None:
    agent = VoiceAgent(profile(greeting="Olá!"))
    mp, session = mock_session(agent)
    with mp.context():
        mp.setattr(VoiceAgent, "session", property(lambda _self: session))
        await agent.on_enter()
    session.say.assert_called_once_with("Olá!")


async def test_no_greeting_means_silence_on_enter() -> None:
    agent = VoiceAgent(profile())
    mp, session = mock_session(agent)
    with mp.context():
        mp.setattr(VoiceAgent, "session", property(lambda _self: session))
        await agent.on_enter()
    session.say.assert_not_called()
    assert agent.instructions.startswith("x\n\n")


def message(text: str) -> llm.ChatMessage:
    return llm.ChatMessage(role="user", content=[text])


async def test_when_named_mode_stays_quiet_unless_called() -> None:
    agent = VoiceAgent(profile(respond_mode="when_named"))
    ctx = llm.ChatContext()

    with pytest.raises(StopResponse):
        await agent.on_user_turn_completed(ctx, message("vamos falar do orçamento"))
    await agent.on_user_turn_completed(ctx, message("Kaiser, qual é o prazo?"))


async def test_always_mode_answers_everything() -> None:
    agent = VoiceAgent(profile())
    await agent.on_user_turn_completed(llm.ChatContext(), message("qualquer coisa"))


@pytest.mark.parametrize(
    ("metadata", "name", "mode"),
    [
        ('{"agentName": "Kaiser"}', "Kaiser", "voice"),
        (r'{"agentName": "  Ana\n  Paula\u0007 "}', "Ana Paula", "voice"),
        ('{"agentName": ""}', "Assistente de IA", "voice"),
        ("not json", "Assistente de IA", "voice"),
        ('{"mode": "captions", "agentName": "Kaiser"}', "Legendas", "captions"),
    ],
)
async def test_jobs_join_under_the_agent_real_name(
    metadata: str, name: str, mode: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(main, "get_settings", MagicMock())
    monkeypatch.setattr(main, "load_profile", AsyncMock(return_value=profile()))
    request = MagicMock()
    request.job.metadata = metadata
    request.accept = AsyncMock()

    await main.on_request(request)

    request.accept.assert_awaited_once_with(name=name, attributes={"impa.mode": mode})


async def test_jobs_say_which_agent_they_are_and_what_for(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(main, "get_settings", MagicMock())
    monkeypatch.setattr(main, "load_profile", AsyncMock(return_value=profile()))
    request = MagicMock()
    request.job.metadata = (
        '{"agentId": "a-1", "agentName": "Ana", "agentDescription": " Vendas  do mês "}'
    )
    request.accept = AsyncMock()

    await main.on_request(request)

    request.accept.assert_awaited_once_with(
        name="Ana",
        attributes={"impa.mode": "voice", "impa.agent": "a-1", "impa.about": "Vendas do mês"},
    )


def test_display_name_is_capped() -> None:
    assert len(display_name('{"agentName": "' + "x" * 200 + '"}')) == MAX_DISPLAY_NAME_LENGTH


def _peer(identity: str, name: str, mode: str = "voice") -> MagicMock:
    p = MagicMock()
    p.identity = identity
    p.name = name
    p.kind = rtc.ParticipantKind.PARTICIPANT_KIND_AGENT
    p.attributes = {"impa.mode": mode}
    return p


def test_peer_agents_are_the_other_voice_assistants() -> None:
    room = MagicMock()
    person = _peer("u-1", "Bia")
    person.kind = rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD
    room.remote_participants = {
        "a": _peer("a", "Ana"),
        "c": _peer("c", "Legendas", mode="captions"),
        "u-1": person,
    }
    assert [p.name for p in main.peer_agents(room)] == ["Ana"]


async def test_handoff_goes_privately_to_the_named_assistant() -> None:
    room = MagicMock()
    room.remote_participants = {"a": _peer("agent-A", "Ána")}
    room.local_participant.send_text = AsyncMock()
    send = main.handoff_sender(room, "Kaiser")

    answer = await send("ana", "apresente as vendas")

    room.local_participant.send_text.assert_awaited_once()
    args, kwargs = room.local_participant.send_text.call_args
    assert kwargs == {"topic": main.HANDOFF_TOPIC, "destination_identities": ["agent-A"]}
    assert '"from": "Kaiser"' in args[0]
    assert "apresente as vendas" in args[0]
    assert "Ána vai continuar" in answer
    assert "Não há assistente chamado Zé" in await send("Zé", "x")


async def test_assistants_wait_their_turn_when_there_are_others() -> None:
    agent = VoiceAgent(profile(name="Ana"))
    agent.update_instructions = AsyncMock()  # type: ignore[method-assign]
    await agent.set_peers(["Kaiser", "Ana", ""])
    assert agent.peers == ("Kaiser",)
    assert "OUTROS ASSISTENTES" in agent.update_instructions.call_args.args[0]

    message = llm.ChatMessage(role="user", content=["Kaiser, apresente e depois passe para a Ana"])
    with pytest.raises(StopResponse):
        await agent.on_user_turn_completed(llm.ChatContext(), message)
    await agent.on_user_turn_completed(
        llm.ChatContext(), llm.ChatMessage(role="user", content=["Ana, sua vez"])
    )


async def test_unconfigured_agents_are_turned_away(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(main, "get_settings", MagicMock())
    monkeypatch.setattr(main, "load_profile", AsyncMock(return_value=None))
    request = MagicMock()
    request.job.metadata = '{"agentId": "a-1", "agentName": "Ana"}'
    request.accept = AsyncMock()
    request.reject = AsyncMock()

    await main.on_request(request)

    request.reject.assert_awaited_once()
    request.accept.assert_not_awaited()


async def test_entrypoint_stops_when_the_agent_is_not_configured(
    process_env: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(main, "load_profile", AsyncMock(return_value=None))
    session = MagicMock()
    monkeypatch.setattr(main, "AgentSession", session)
    ctx = MagicMock()
    ctx.job.metadata = '{"agentId": "a1"}'

    await main.entrypoint(ctx)

    ctx.shutdown.assert_called_once()
    session.assert_not_called()
