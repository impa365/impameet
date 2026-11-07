"""Agent server entry point: ``meet-impar-agent start`` (or ``dev`` locally)."""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable, Iterable
from typing import Any

from livekit import rtc
from livekit.agents import AgentServer, AgentSession, JobContext, JobProcess, JobRequest, cli
from livekit.plugins import silero

from . import redaction, telemetry
from .captions import MODE_ATTRIBUTE, run_captions
from .config import Settings, get_settings
from .listening import Speaker, next_linked, same_name
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
    display_name,
    job_mode,
    join_attributes,
    load_profile,
    thinking_sound,
)
from .screen import ScreenClient

logger = logging.getLogger("meet_impar_agent")
MUTED_ATTRIBUTE = "impa.muted"
MAX_TOOL_STEPS = 10
HANDOFF_TOPIC = "impa.handoff"
AGENT_SETTINGS_TOPIC = "impa.agent"
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


def _build_agent(
    ctx: JobContext, settings: Settings, profile: AgentProfile, session: AgentSession[Any]
) -> VoiceAgent:
    """Screen sharing tools exist only when the optional screen service is configured."""

    async def on_mute(muted: bool) -> None:
        await ctx.room.local_participant.set_attributes({MUTED_ATTRIBUTE: "true" if muted else ""})

    screen = None
    if settings.screen:
        screen = ScreenClient(settings.screen, ctx.room.name)
        ctx.add_shutdown_callback(screen.aclose)
    return VoiceAgent(
        profile,
        speaker=speaker_lookup(session),
        on_mute=on_mute,
        screen=screen,
        handoff=handoff_sender(ctx.room, profile.name),
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

    agent = _build_agent(ctx, settings, profile, session)
    await session.start(agent=agent, room=ctx.room, record=False)
    # Lets the platform tell the voice agent apart from captions and the AI screen.
    await ctx.room.local_participant.set_attributes({MODE_ATTRIBUTE: "voice"})
    follow_speakers(ctx.room, session, profile.listen_mode)
    follow_peers(ctx.room, agent)

    if thinking_audio := build_thinking_audio(
        settings.agent, enabled=thinking_sound(ctx.job.metadata)
    ):
        await thinking_audio.start(room=ctx.room, agent_session=session)
        ctx.add_shutdown_callback(thinking_audio.aclose)
        follow_room_settings(ctx.room, thinking_audio)


def follow_room_settings(room: rtc.Room, thinking_audio: ThinkingAudio) -> None:
    """Applies the room's agent settings changed during the meeting (the typing sound)."""

    def on_data(packet: rtc.DataPacket) -> None:
        if packet.topic != AGENT_SETTINGS_TOPIC or packet.participant is not None:
            return  # only the server (no participant) sends room settings
        try:
            data = json.loads(packet.data)
        except ValueError:
            return
        if isinstance(data, dict) and isinstance(data.get("thinkingSound"), bool):
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
