from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
from livekit import rtc
from livekit.agents import stt
from pydantic import SecretStr

from meet_impar_agent import captions, main
from meet_impar_agent.captions import (
    CAPTIONS_TOPIC,
    MAX_LINES,
    Captioner,
    Transcript,
    caption_message,
    save_transcript,
    transcribe_track,
)
from meet_impar_agent.config import PlatformSettings, load_settings
from meet_impar_agent.profile import job_mode

AGENT = rtc.ParticipantKind.PARTICIPANT_KIND_AGENT
STANDARD = rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD
PLATFORM = PlatformSettings(url="http://platform:3000", token=SecretStr("tok"))  # type: ignore[arg-type]


def event(kind: stt.SpeechEventType, text: str = "") -> stt.SpeechEvent:
    alternatives = [stt.SpeechData(language="pt", text=text)] if text else []
    return stt.SpeechEvent(type=kind, alternatives=alternatives)


class FakeStream:
    def __init__(self, events: list[stt.SpeechEvent]) -> None:
        self.events = events
        self.frames: list[object] = []
        self.ended = False
        self.closed = False

    def push_frame(self, frame: object) -> None:
        self.frames.append(frame)

    def end_input(self) -> None:
        self.ended = True

    def __aiter__(self) -> AsyncIterator[stt.SpeechEvent]:
        async def gen() -> AsyncIterator[stt.SpeechEvent]:
            for e in self.events:
                await asyncio.sleep(0)
                yield e

        return gen()

    async def aclose(self) -> None:
        self.closed = True


class FakeEngine:
    def __init__(self, events: list[stt.SpeechEvent]) -> None:
        self.streams: list[FakeStream] = []
        self.events = events

    def stream(self) -> FakeStream:
        self.streams.append(FakeStream(self.events))
        return self.streams[-1]


class FakeAudioStream:
    def __init__(self, track: object, **_: Any) -> None:
        self.track = track

    def __aiter__(self) -> AsyncIterator[SimpleNamespace]:
        async def gen() -> AsyncIterator[SimpleNamespace]:
            yield SimpleNamespace(frame="f1")
            yield SimpleNamespace(frame="f2")

        return gen()

    async def aclose(self) -> None: ...


def participant(identity: str, kind: Any = STANDARD, name: str = "") -> Any:
    return SimpleNamespace(identity=identity, name=name, kind=kind, track_publications={})


def track(sid: str, kind: Any = rtc.TrackKind.KIND_AUDIO) -> Any:
    return SimpleNamespace(sid=sid, kind=kind)


class FakeRoom:
    def __init__(self) -> None:
        self.name = "t1.sala"
        self.handlers: dict[str, Any] = {}
        self.text_handlers: dict[str, Any] = {}
        self.remote_participants: dict[str, Any] = {}
        self.sent: list[tuple[str, str]] = []
        self.attributes: dict[str, str] = {}
        self.local_participant = self

    def on(self, event_name: str, fn: Any) -> None:
        self.handlers[event_name] = fn

    def register_text_stream_handler(self, topic: str, fn: Any) -> None:
        self.text_handlers[topic] = fn

    async def send_text(self, text: str, *, topic: str) -> None:
        self.sent.append((topic, text))

    async def set_attributes(self, attributes: dict[str, str]) -> None:
        self.attributes.update(attributes)


def test_job_mode() -> None:
    assert job_mode('{"mode": "captions"}') == "captions"
    assert job_mode('{"agentId": "x"}') == "voice"
    assert job_mode("[1]") == "voice"
    assert job_mode(None) == "voice"


def test_transcript_and_messages() -> None:
    t = Transcript(started_at=100.0)
    t.add("u-1", "Ana", "Olá", now=103.25)
    payload = t.payload("t1.sala")
    assert payload["room"] == "t1.sala"
    assert payload["lines"] == [{"at": 3.2, "identity": "u-1", "name": "Ana", "text": "Olá"}]
    t.lines = [{}] * MAX_LINES
    t.add("u-1", "Ana", "demais")
    assert len(t.lines) == MAX_LINES
    msg = json.loads(caption_message("u-1", "Ana", "ação", final=True, segment="s1"))
    assert msg == {"identity": "u-1", "name": "Ana", "text": "ação", "final": True, "id": "s1"}


async def test_transcribe_track_publishes_interim_and_final(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(captions.rtc, "AudioStream", FakeAudioStream)
    engine = FakeEngine(
        [
            event(stt.SpeechEventType.START_OF_SPEECH),
            event(stt.SpeechEventType.INTERIM_TRANSCRIPT, "bom"),
            event(stt.SpeechEventType.INTERIM_TRANSCRIPT, "  "),
            event(stt.SpeechEventType.FINAL_TRANSCRIPT, "bom dia"),
            event(stt.SpeechEventType.FINAL_TRANSCRIPT),
            event(stt.SpeechEventType.FINAL_TRANSCRIPT, "tudo bem?"),
        ]
    )
    published: list[tuple[str, str, str, bool, str]] = []

    async def publish(*args: Any) -> None:
        published.append(args)

    await transcribe_track(engine, participant("u-1"), track("TR1"), publish)  # type: ignore[arg-type]
    assert [(p[1], p[2], p[3]) for p in published] == [
        ("u-1", "bom", False),
        ("u-1", "bom dia", True),
        ("u-1", "tudo bem?", True),
    ]
    assert published[0][4] == published[1][4] != published[2][4]
    assert engine.streams[0].closed


async def test_captioner_follows_microphones_and_relays_the_agent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    started: list[str] = []

    async def fake_transcribe(engine: Any, p: Any, t: Any, publish: Any) -> None:
        started.append(t.sid)
        await publish(p.identity, p.name or p.identity, "oi", True, "s")
        await asyncio.sleep(10)

    monkeypatch.setattr(captions, "transcribe_track", fake_transcribe)
    room = FakeRoom()
    ana = participant("u-ana", name="Ana")
    ana.track_publications = {
        "TR_A": SimpleNamespace(track=track("TR_A")),
        "TR_V": SimpleNamespace(track=None),
    }
    kaiser = participant("agent-1", AGENT, "Kaiser")
    kaiser.track_publications = {"TR_K": SimpleNamespace(track=track("TR_K"))}
    room.remote_participants = {"u-ana": ana, "agent-1": kaiser}
    transcript = Transcript()
    captioner = Captioner(room, FakeEngine([]), transcript)  # type: ignore[arg-type]

    captioner.attach()
    room.handlers["track_subscribed"](track("TR_A"), None, ana)  # duplicate is ignored
    room.handlers["track_subscribed"](track("TR_CAM", rtc.TrackKind.KIND_VIDEO), None, ana)
    bob = participant("u-bob", name="")
    room.handlers["track_subscribed"](track("TR_B"), None, bob)
    await asyncio.sleep(0.01)
    assert started == ["TR_A", "TR_B"]
    assert [json.loads(text)["name"] for topic, text in room.sent if topic == CAPTIONS_TOPIC] == [
        "Ana",
        "u-bob",
    ]
    assert [line["text"] for line in transcript.lines] == ["oi", "oi"]

    room.handlers["track_unsubscribed"](track("TR_B"), None, bob)
    room.handlers["track_unsubscribed"](track("TR_X"), None, bob)

    def reader(track_id: str, text: str) -> Any:
        return SimpleNamespace(
            info=SimpleNamespace(attributes={"lk.transcribed_track_id": track_id}),
            read_all=AsyncMock(return_value=text),
        )

    handler = room.text_handlers["lk.transcription"]
    handler(reader("TR_K", "Sou o Kaiser."), "agent-1")
    handler(reader("TR_A", "linha da Ana publicada pelo agente"), "agent-1")
    handler(reader("TR_A", "x"), "u-ana")
    handler(reader("TR_K", "x"), "desconhecido")
    handler(reader("TR_K", "   "), "agent-1")
    await asyncio.sleep(0.01)
    assert [line["text"] for line in transcript.lines] == ["oi", "oi", "Sou o Kaiser."]
    assert transcript.lines[-1]["name"] == "Kaiser"
    await captioner.close()


async def test_save_transcript() -> None:
    requests: list[httpx.Request] = []

    def ok(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(201, json={"ok": True})

    t = Transcript()
    assert not await save_transcript(PLATFORM, t, "r")
    t.add("u-1", "Ana", "oi")
    assert not await save_transcript(None, t, "r")
    assert await save_transcript(PLATFORM, t, "t1.sala", transport=httpx.MockTransport(ok))
    assert str(requests[0].url) == "http://platform:3000/api/internal/transcripts"
    assert requests[0].headers["x-internal-token"] == "tok"
    assert json.loads(requests[0].content)["room"] == "t1.sala"

    refused = httpx.MockTransport(lambda r: httpx.Response(404))
    assert not await save_transcript(PLATFORM, t, "r", transport=refused)

    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    assert not await save_transcript(PLATFORM, t, "r", transport=httpx.MockTransport(down))


async def test_run_captions_marks_itself_and_saves_on_shutdown(
    monkeypatch: pytest.MonkeyPatch, env: dict[str, str]
) -> None:
    settings = load_settings(env)
    room = FakeRoom()
    ctx = MagicMock()
    ctx.room = room
    ctx.connect = AsyncMock()
    saved = AsyncMock(return_value=True)
    monkeypatch.setattr(captions, "save_transcript", saved)
    agent = MagicMock(fish_api_key="fish-agent-0123456789", stt_model="transcribe-stream-1")
    monkeypatch.setattr(captions, "load_profile", AsyncMock(return_value=agent))

    await captions.run_captions(ctx, settings)

    assert ctx.connect.await_args.kwargs["auto_subscribe"].value == "audio_only"
    assert room.attributes == {"impa.mode": "captions"}
    finish = ctx.add_shutdown_callback.call_args.args[0]
    await finish()
    saved.assert_awaited_once()
    assert saved.await_args.args[2] == "t1.sala"


async def test_entrypoint_runs_captions_for_caption_dispatches(
    monkeypatch: pytest.MonkeyPatch, env: dict[str, str]
) -> None:
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    run = AsyncMock()
    monkeypatch.setattr(main, "run_captions", run)
    session = MagicMock()
    monkeypatch.setattr(main, "AgentSession", session)
    ctx = MagicMock()
    ctx.job.metadata = '{"mode": "captions"}'

    await main.entrypoint(ctx)

    run.assert_awaited_once()
    session.assert_not_called()
    assert ctx.log_context_fields["agent"] == "captions"
