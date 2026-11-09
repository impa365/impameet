"""Agent server entry point: ``meet-impar-agent start`` (or ``dev`` locally)."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import Awaitable, Callable, Iterable
from typing import Any

import httpx
from livekit import rtc
from livekit.agents import AgentServer, AgentSession, JobContext, JobProcess, JobRequest, cli
from livekit.plugins import silero

from . import redaction, telemetry
from .captions import MODE_ATTRIBUTE, run_captions
from .config import Settings, get_settings
from .insights import (
    COPILOT_TOPIC,
    Copilot,
    MeetingRecord,
    insights_attributes,
    llm_answer,
    send_report,
)
from .listening import Speaker, next_linked, same_name
from .moderation import ModerationClient
from .perception import BOARD_TOPIC, POLICY_TOPIC, POLLS_TOPIC, Board, Perception
from .persona import Talker, VoiceAgent
from .pipeline import (
    ThinkingAudio,
    build_conn_options,
    build_llm,
    build_stt,
    build_thinking_audio,
    build_tts,
    build_turn_handling,
)
from .profile import (
    AgentProfile,
    ListenMode,
    agent_actions,
    board_policy,
    display_name,
    job_mode,
    join_attributes,
    load_profile,
    thinking_sound,
)
from .screen import ScreenClient
from .tools import ToolsClient, ToolSpec

logger = logging.getLogger("meet_impar_agent")
MUTED_ATTRIBUTE = "impa.muted"
MAX_TOOL_STEPS = 10
HANDOFF_TOPIC = "impa.handoff"
AGENT_SETTINGS_TOPIC = "impa.agent"
LOBBY_TOPIC = "impa.lobby"
MAX_HANDOFF_CHARS = 500


def quiet_stream_noise(record: logging.LogRecord) -> bool:
    """LiveKit logs every data stream nobody listens to (about once per second per agent)."""
    return not str(record.msg).startswith(("ignoring byte stream", "ignoring text stream"))


def prewarm(proc: JobProcess) -> None:
    redaction.install(get_settings().secret_values())
    logging.getLogger().addFilter(quiet_stream_noise)
    proc.userdata["vad"] = silero.VAD.load()


def _speaker(p: rtc.Participant) -> Speaker:
    return Speaker(
        identity=p.identity,
        role=(p.attributes or {}).get("role", "participant"),
        is_agent=p.kind == rtc.ParticipantKind.PARTICIPANT_KIND_AGENT,
    )


def follow_speakers(room: rtc.Room, session: AgentSession[Any], mode: ListenMode) -> None:
    """Keeps the agent listening to whoever is talking (within the listen mode)."""

    def relink(participants: Iterable[rtc.Participant]) -> None:
        linked = session.room_io.linked_participant
        local = room.local_participant.identity
        target = next_linked(
            (_speaker(p) for p in participants if p.identity != local),
            linked.identity if linked else None,
            mode,
        )
        if target:
            session.room_io.set_participant(target)

    room.on("active_speakers_changed", relink)
    if mode != "everyone":
        relink(room.remote_participants.values())


def speaker_lookup(session: AgentSession[Any]) -> Callable[[], Talker | None]:
    """The person the agent is listening to right now (name and room role)."""

    def lookup() -> Talker | None:
        try:
            participant = session.room_io.linked_participant
        except Exception:
            return None
        if participant is None:
            return None
        role = (participant.attributes or {}).get("role", "participant")
        return Talker(
            name=participant.name or participant.identity, role=role, identity=participant.identity
        )

    return lookup


def peer_agents(room: rtc.Room) -> list[rtc.RemoteParticipant]:
    """The other voice assistants in the room (not captions, not the AI screen)."""
    return [
        p
        for p in room.remote_participants.values()
        if p.kind == rtc.ParticipantKind.PARTICIPANT_KIND_AGENT
        and (p.attributes or {}).get(MODE_ATTRIBUTE) == "voice"
    ]


def handoff_sender(room: rtc.Room, my_name: str) -> Callable[[str, str], Awaitable[str]]:
    """The passar_a_vez tool: a private message to the named assistant."""

    async def send(name: str, request: str) -> str:
        peers = peer_agents(room)
        target = next((p for p in peers if same_name(p.name, name)), None)
        if target is None:
            here = ", ".join(p.name for p in peers if p.name) or "nenhum"
            return f"Não há assistente chamado {name} na reunião. Assistentes presentes: {here}."
        payload = json.dumps({"from": my_name, "request": request[:MAX_HANDOFF_CHARS]})
        await room.local_participant.send_text(
            payload, topic=HANDOFF_TOPIC, destination_identities=[target.identity]
        )
        return (
            f"Pronto: {target.name} vai continuar agora. "
            "Diga no máximo uma frase passando a palavra."
        )

    return send


def follow_peers(room: rtc.Room, agent: VoiceAgent) -> None:
    """Keeps the agent aware of the other assistants, and lets them hand it the floor."""
    tasks: set[asyncio.Task[None]] = set()

    def spawn(coro: Awaitable[None]) -> None:
        task = asyncio.ensure_future(coro)
        tasks.add(task)
        task.add_done_callback(tasks.discard)

    def refresh(*_: Any) -> None:
        spawn(agent.set_peers(p.name for p in peer_agents(room)))

    def on_handoff(reader: rtc.TextStreamReader, sender: str) -> None:
        async def take() -> None:
            giver = room.remote_participants.get(sender)
            if giver is None or giver.kind != rtc.ParticipantKind.PARTICIPANT_KIND_AGENT:
                return
            try:
                data = json.loads(await reader.read_all())
            except ValueError:
                return
            if isinstance(data, dict):
                await agent.take_floor(
                    giver.name, str(data.get("request") or "")[:MAX_HANDOFF_CHARS]
                )

        spawn(take())

    room.on("participant_connected", refresh)
    room.on("participant_disconnected", refresh)
    room.on("participant_attributes_changed", refresh)
    room.register_text_stream_handler(HANDOFF_TOPIC, on_handoff)
    refresh()


async def load_tools(
    settings: Settings, profile: AgentProfile, room: str
) -> tuple[ToolsClient | None, tuple[ToolSpec, ...]]:
    """The external tools the admin gave this agent; without them the agent still works."""
    if not settings.platform or not profile.agent_id:
        return None, ()
    client = ToolsClient(settings.platform, profile.agent_id, room)
    try:
        specs = await client.specs()
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("could not load external tools", extra={"error": type(exc).__name__})
        specs = ()
    if not specs:
        await client.aclose()
        return None, ()
    return client, specs


def _build_agent(
    ctx: JobContext,
    settings: Settings,
    profile: AgentProfile,
    session: AgentSession[Any],
    tools: tuple[ToolsClient | None, tuple[ToolSpec, ...]] = (None, ()),
    *,
    record: MeetingRecord | None = None,
) -> VoiceAgent:
    """Screen sharing tools exist only when the optional screen service is configured."""

    async def on_mute(muted: bool) -> None:
        await ctx.room.local_participant.set_attributes({MUTED_ATTRIBUTE: "true" if muted else ""})

    screen = None
    if settings.screen:
        screen = ScreenClient(settings.screen, ctx.room.name)
        ctx.add_shutdown_callback(screen.aclose)
    moderation = None
    if settings.platform and profile.moderation_tools and profile.agent_id:
        moderation = ModerationClient(settings.platform, profile.agent_id, ctx.room.name)
        ctx.add_shutdown_callback(moderation.aclose)
    tools_client, tool_specs = tools
    if tools_client is not None:
        ctx.add_shutdown_callback(tools_client.aclose)
    perception = None
    if profile.perception:
        perception = Perception(
            ctx.room, profile.perception, board=Board(policy=board_policy(ctx.job.metadata))
        )
    return VoiceAgent(
        profile,
        speaker=speaker_lookup(session),
        on_mute=on_mute,
        screen=screen,
        handoff=handoff_sender(ctx.room, profile.name),
        moderation=moderation,
        tools_client=tools_client,
        tool_specs=tool_specs,
        perception=perception,
        actions=agent_actions(ctx.job.metadata),
        hearing=(
            (lambda who, text: record.heard(who.identity, who.name, who.role, text))
            if record is not None
            else None
        ),
    )


async def entrypoint(ctx: JobContext) -> None:
    settings = get_settings()
    redaction.install(settings.secret_values())
    if job_mode(ctx.job.metadata) == "captions":
        ctx.log_context_fields = {"room": ctx.room.name, "agent": "captions"}
        await run_captions(ctx, settings)
        return
    profile = await load_profile(settings, ctx.job.metadata)
    if profile is None:
        ctx.shutdown(reason="agent not fully configured")
        return
    ctx.log_context_fields = {"room": ctx.room.name, "agent": profile.name}

    session: AgentSession[None] = AgentSession(
        stt=build_stt(
            profile.stt_provider,
            settings.fish,
            api_key=profile.stt_api_key or "",
            model=profile.stt_model,
            languages=tuple(profile.voices),
        ),
        llm=build_llm(
            settings.llm,
            model=profile.llm_model,
            base_url=profile.llm_base_url or "",
            api_key=profile.llm_api_key or "",
        ),
        tts=build_tts(
            profile.tts_provider,
            settings.fish,
            voice_id=profile.voice_id or "",
            model=profile.tts_model,
            api_key=profile.tts_api_key or "",
        ),
        vad=ctx.proc.userdata["vad"],
        turn_handling=build_turn_handling(),
        conn_options=build_conn_options(settings.llm),
        tts_text_transforms=["filter_emoji", "filter_markdown"],
        aec_warmup_duration=3.0,
        # Showing a page, looking, scrolling and clicking chain several tools in one answer.
        max_tool_steps=MAX_TOOL_STEPS,
    )

    telemetry.attach(session)

    async def _log_usage() -> None:
        logger.info("session usage: %s", session.usage)

    ctx.add_shutdown_callback(_log_usage)

    record = meeting_record(profile)
    agent = _build_agent(
        ctx,
        settings,
        profile,
        session,
        await load_tools(settings, profile, ctx.room.name),
        record=record,
    )
    await session.start(agent=agent, room=ctx.room, record=False)
    # Lets the platform tell the voice agent apart from captions and the AI screen.
    await ctx.room.local_participant.set_attributes(
        {MODE_ATTRIBUTE: "voice", **insights_attributes(profile.insights, profile.insights_access)}
    )
    if record is not None:
        follow_record(ctx.room, session, record, profile.name)
        if set(profile.insights) & {"catchup", "copilot", "metrics"}:
            follow_copilot(
                ctx.room,
                Copilot(
                    ctx.room,
                    record,
                    profile.insights,
                    profile.insights_access,
                    llm_answer(session.llm),  # type: ignore[arg-type]
                ),
            )
        if (
            settings.platform
            and profile.agent_id
            and {"minutes", "metrics"} & set(profile.insights)
        ):
            platform, agent_id = settings.platform, profile.agent_id

            async def _report() -> None:
                report = record.report(ctx.room.name, include_lines="minutes" in profile.insights)
                await send_report(platform, agent_id, report)

            ctx.add_shutdown_callback(_report)
    follow_speakers(ctx.room, session, profile.listen_mode)
    follow_peers(ctx.room, agent)
    follow_lobby(ctx.room, agent)
    follow_agent_settings(ctx.room, agent)
    if agent.perception is not None:
        await follow_meeting(ctx.room, agent.perception)

    if thinking_audio := build_thinking_audio(
        settings.agent, enabled=thinking_sound(ctx.job.metadata)
    ):
        await thinking_audio.start(room=ctx.room, agent_session=session)
        ctx.add_shutdown_callback(thinking_audio.aclose)
        follow_room_settings(ctx.room, thinking_audio)


def follow_lobby(room: rtc.Room, agent: VoiceAgent) -> None:
    """The server says someone knocked; an agent that answers the waiting room speaks up."""

    def on_data(packet: rtc.DataPacket) -> None:
        if packet.topic == LOBBY_TOPIC and packet.participant is None:
            agent.on_lobby_knock()

    room.on("data_received", on_data)


def _server_settings(packet: rtc.DataPacket) -> dict[str, Any] | None:
    """Room settings the server sent (no participant sends them)."""
    if packet.topic != AGENT_SETTINGS_TOPIC or packet.participant is not None:
        return None
    try:
        data = json.loads(packet.data)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


_TASKS: set[asyncio.Future[Any]] = set()


def spawn(coro: Awaitable[Any]) -> None:
    """Runs a coroutine in the background, keeping it alive until it ends."""
    task = asyncio.ensure_future(coro)
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)


def meeting_record(profile: AgentProfile) -> MeetingRecord | None:
    """Kept only when the admin turned an insight on; the conversation only when one needs it."""
    if not profile.insights:
        return None
    return MeetingRecord(keep_lines=bool({"minutes", "catchup", "copilot"} & set(profile.insights)))


def follow_record(
    room: rtc.Room, session: AgentSession[Any], record: MeetingRecord, agent_name: str
) -> None:
    """Who joins and leaves, who is talking and what the agent itself says."""

    def joined(p: rtc.RemoteParticipant) -> None:
        if p.kind != rtc.ParticipantKind.PARTICIPANT_KIND_AGENT:
            record.joined(p.identity, p.name or p.identity, (p.attributes or {}).get("role", ""))

    for p in room.remote_participants.values():
        joined(p)
    room.on("participant_connected", joined)
    room.on("participant_disconnected", lambda p: record.left(p.identity))
    room.on("active_speakers_changed", lambda ps: record.speakers({p.identity for p in ps}))

    def said(event: Any) -> None:
        item = getattr(event, "item", None)
        if getattr(item, "role", None) == "assistant":
            record.said(agent_name, getattr(item, "text_content", None) or "")

    session.on("conversation_item_added", said)


def follow_copilot(room: rtc.Room, copilot: Copilot) -> None:
    """Private requests from the browsers: answered only to whoever asked."""

    def on_stream(reader: Any, identity: str) -> None:
        async def read() -> None:
            with contextlib.suppress(Exception):
                await copilot.handle(await reader.read_all(), identity)

        spawn(read())

    room.register_text_stream_handler(COPILOT_TOPIC, on_stream)


def follow_agent_settings(room: rtc.Room, agent: VoiceAgent) -> None:
    """A moderator switching the AI's actions off (or on) during the meeting."""

    def on_data(packet: rtc.DataPacket) -> None:
        data = _server_settings(packet)
        if data is not None and isinstance(data.get("agentActions"), bool):
            spawn(agent.set_actions(data["agentActions"]))

    room.on("data_received", on_data)


async def follow_meeting(room: rtc.Room, view: Perception) -> None:
    """Keeps the board and polls the agent may look at, and asks the browsers for what exists."""

    def reader(apply: Callable[[str, str], None]) -> Callable[[Any, str], None]:
        def on_stream(stream: Any, identity: str) -> None:
            async def read() -> None:
                with contextlib.suppress(Exception):
                    apply(await stream.read_all(), identity)

            spawn(read())

        return on_stream

    def on_data(packet: rtc.DataPacket) -> None:
        if packet.topic == POLICY_TOPIC and packet.participant is None:
            view.on_policy(packet.data)

    room.on("data_received", on_data)
    request = json.dumps({"type": "request"})
    for topic, apply, kind in (
        (BOARD_TOPIC, view.on_board, "board"),
        (POLLS_TOPIC, view.on_polls, "polls"),
    ):
        if kind not in view.allowed:
            continue
        room.register_text_stream_handler(topic, reader(apply))
        with contextlib.suppress(Exception):
            await room.local_participant.send_text(request, topic=topic)


def follow_room_settings(room: rtc.Room, thinking_audio: ThinkingAudio) -> None:
    """Applies the room's agent settings changed during the meeting (the typing sound)."""

    def on_data(packet: rtc.DataPacket) -> None:
        data = _server_settings(packet)
        if data is not None and isinstance(data.get("thinkingSound"), bool):
            thinking_audio.set_enabled(data["thinkingSound"])

    room.on("data_received", on_data)


async def on_request(request: JobRequest) -> None:
    """Joins under the agent's real name, already marked voice or captions.

    An agent missing any of its own choices (provider, model, voice) is turned away instead
    of falling back to this worker's settings.
    """
    metadata = request.job.metadata
    if await load_profile(get_settings(), metadata) is None:
        await request.reject()
        return
    await request.accept(name=display_name(metadata), attributes=join_attributes(metadata))


def build_server(settings: Settings) -> AgentServer:
    server = AgentServer(
        ws_url=str(settings.livekit.url).rstrip("/"),
        api_key=settings.livekit.api_key.get_secret_value(),
        api_secret=settings.livekit.api_secret.get_secret_value(),
        setup_fnc=prewarm,
    )
    server.rtc_session(entrypoint, agent_name=settings.agent.name, on_request=on_request)
    return server


def run() -> None:
    settings = get_settings()
    redaction.install(settings.secret_values())
    logging.getLogger().setLevel(settings.log_level)
    logging.getLogger().addFilter(quiet_stream_noise)
    cli.run_app(build_server(settings))


if __name__ == "__main__":  # pragma: no cover
    run()
