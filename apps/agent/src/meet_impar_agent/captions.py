"""Live captions: one speech-to-text stream per participant, shown to the room, saved at the end.

Runs instead of the voice agent when a room dispatches the worker with ``{"mode": "captions"}``.
The voice agent's own speech is relayed from its transcription stream, so the saved transcript
covers humans and AI alike.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import httpx
from livekit import rtc
from livekit.agents import AutoSubscribe, JobContext, stt

from .config import PlatformSettings, Settings
from .pipeline import build_stt
from .profile import load_profile

logger = logging.getLogger("meet_impar_agent.captions")

CAPTIONS_TOPIC = "impa.captions"
MODE_ATTRIBUTE = "impa.mode"
AGENT_TRANSCRIPTION_TOPIC = "lk.transcription"
SAVE_TIMEOUT_S = 10.0
MAX_LINES = 20_000

Publish = Callable[[str, str, str, bool, str], Awaitable[None]]


@dataclass
class Transcript:
    started_at: float = field(default_factory=time.time)
    lines: list[dict[str, Any]] = field(default_factory=list)

    def add(self, identity: str, name: str, text: str, *, now: float | None = None) -> None:
        if len(self.lines) >= MAX_LINES:
            return
        at = round((time.time() if now is None else now) - self.started_at, 1)
        self.lines.append({"at": at, "identity": identity, "name": name, "text": text})

    def payload(self, room: str) -> dict[str, Any]:
        return {
            "room": room,
            "startedAt": self.started_at,
            "endedAt": time.time(),
            "lines": self.lines,
        }


def caption_message(identity: str, name: str, text: str, *, final: bool, segment: str) -> str:
    return json.dumps(
        {"identity": identity, "name": name, "text": text, "final": final, "id": segment},
        ensure_ascii=False,
    )


async def transcribe_track(
    engine: stt.STT[Any], participant: rtc.RemoteParticipant, track: rtc.Track, publish: Publish
) -> None:
    """Feeds one participant's microphone to STT and publishes every (interim/final) result."""
    stream = engine.stream()
    audio = rtc.AudioStream(track, sample_rate=16_000, num_channels=1)

    async def pump() -> None:
        async for event in audio:
            stream.push_frame(event.frame)
        stream.end_input()

    pumping = asyncio.create_task(pump())
    segment = uuid.uuid4().hex
    try:
        async for event in stream:
            if event.type not in (
                stt.SpeechEventType.INTERIM_TRANSCRIPT,
                stt.SpeechEventType.FINAL_TRANSCRIPT,
            ):
                continue
            text = event.alternatives[0].text.strip() if event.alternatives else ""
            if not text:
                continue
            final = event.type == stt.SpeechEventType.FINAL_TRANSCRIPT
            name = participant.name or participant.identity
            await publish(participant.identity, name, text, final, segment)
            if final:
                segment = uuid.uuid4().hex
    finally:
        pumping.cancel()
        with contextlib.suppress(Exception):
            await stream.aclose()
        with contextlib.suppress(Exception):
            await audio.aclose()


def _is_agent(participant: rtc.Participant) -> bool:
    return participant.kind == rtc.ParticipantKind.PARTICIPANT_KIND_AGENT


async def save_transcript(
    platform: PlatformSettings | None,
    transcript: Transcript,
    room: str,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> bool:
    if platform is None or not transcript.lines:
        return False
    url = f"{str(platform.url).rstrip('/')}/api/internal/transcripts"
    try:
        async with httpx.AsyncClient(timeout=SAVE_TIMEOUT_S, transport=transport) as client:
            res = await client.post(
                url,
                json=transcript.payload(room),
                headers={"x-internal-token": platform.token.get_secret_value()},
            )
    except httpx.HTTPError:
        logger.warning("could not save the transcript")
        return False
    if not res.is_success:
        logger.warning("platform refused the transcript (%s)", res.status_code)
    return res.is_success


class Captioner:
    """Tracks the room's microphones and keeps one transcription task per audio track."""

    def __init__(self, room: rtc.Room, engine: stt.STT[Any], transcript: Transcript) -> None:
        self._room = room
        self._engine = engine
        self._transcript = transcript
        self._tasks: dict[str, asyncio.Task[None]] = {}

    async def publish(self, identity: str, name: str, text: str, final: bool, segment: str) -> None:
        message = caption_message(identity, name, text, final=final, segment=segment)
        with contextlib.suppress(Exception):
            await self._room.local_participant.send_text(message, topic=CAPTIONS_TOPIC)
        if final:
            self._transcript.add(identity, name, text)

    def on_track_subscribed(
        self, track: rtc.Track, _pub: rtc.RemoteTrackPublication, participant: rtc.RemoteParticipant
    ) -> None:
        if track.kind != rtc.TrackKind.KIND_AUDIO or _is_agent(participant):
            return
        if track.sid in self._tasks:
            return
        self._tasks[track.sid] = asyncio.create_task(
            transcribe_track(self._engine, participant, track, self.publish)
        )

    def on_track_unsubscribed(
        self, track: rtc.Track, _pub: rtc.RemoteTrackPublication, _p: rtc.RemoteParticipant
    ) -> None:
        if task := self._tasks.pop(track.sid, None):
            task.cancel()

    def on_agent_transcription(self, reader: rtc.TextStreamReader, identity: str) -> None:
        """Relays the voice agent's own final lines (not the user lines it also publishes)."""
        speaker = self._room.remote_participants.get(identity)
        attributes = reader.info.attributes or {}
        track_id = attributes.get("lk.transcribed_track_id", "")
        if speaker is None or not _is_agent(speaker) or track_id not in speaker.track_publications:
            return

        async def relay() -> None:
            with contextlib.suppress(Exception):
                text = (await reader.read_all()).strip()
                if text:
                    await self.publish(
                        identity, speaker.name or identity, text, True, uuid.uuid4().hex
                    )

        task = asyncio.create_task(relay())
        self._tasks[f"relay-{id(task)}"] = task
        task.add_done_callback(lambda t: self._tasks.pop(f"relay-{id(t)}", None))

    def attach(self) -> None:
        self._room.on("track_subscribed", self.on_track_subscribed)
        self._room.on("track_unsubscribed", self.on_track_unsubscribed)
        self._room.register_text_stream_handler(
            AGENT_TRANSCRIPTION_TOPIC, self.on_agent_transcription
        )
        for participant in self._room.remote_participants.values():
            for publication in participant.track_publications.values():
                if publication.track is not None:
                    self.on_track_subscribed(publication.track, publication, participant)

    async def close(self) -> None:
        for task in list(self._tasks.values()):
            task.cancel()
        self._tasks.clear()


async def run_captions(ctx: JobContext, settings: Settings) -> None:
    # The room's agent decides which provider, account and model transcribe the meeting.
    profile = await load_profile(settings, ctx.job.metadata)
    if profile is None:
        ctx.shutdown(reason="agent not fully configured")
        return
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)
    await ctx.room.local_participant.set_attributes({MODE_ATTRIBUTE: "captions"})
    transcript = Transcript()
    stt = build_stt(
        profile.stt_provider,
        api_key=profile.stt_api_key or "",
        model=profile.stt_model,
        languages=tuple(profile.voices),
    )
    captioner = Captioner(ctx.room, stt, transcript)
    captioner.attach()

    async def finish() -> None:
        await captioner.close()
        await save_transcript(settings.platform, transcript, ctx.room.name)

    ctx.add_shutdown_callback(finish)
