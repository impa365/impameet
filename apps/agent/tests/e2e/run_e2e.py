"""End-to-end check against a real LiveKit server and the deployed agent.

Stage 1 (always): create a room, dispatch the agent, join as a human and verify the agent
joins as an AGENT participant and publishes its audio track.

Stage 2 (``E2E_CONVERSATION=1``, needs real Fish Audio + LLM credentials): speak a question
synthesised by Fish Audio, then assert the agent answers with audio and a transcript, and
report the voice-to-voice latency.

Stage 3 (``E2E_GUEST=1``): a silent moderator joins first and the question comes from a
guest who joins later, proving the agent listens to whoever speaks, not only the first person.

Stage 4 (``E2E_SCREEN=1``, needs the screen service): the guest asks, by voice, for topics on
the screen and the agent must start a screen share that delivers video frames.

Exit code 0 means every enabled stage passed.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import sys
import time
import unicodedata
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

import aiohttp
import numpy as np
from livekit import api, rtc
from livekit.plugins import fishaudio

from meet_impar_agent.config import read_secret

AGENT_NAME = os.environ.get("AGENT_NAME", "").strip() or "kaiser"
JOIN_TIMEOUT_S = 30.0
ANSWER_TIMEOUT_S = 25.0
GREETING_GRACE_S = 6.0
QUESTION = "Olá! Quanto é dois mais dois? Responda só com o número."
SCREEN_QUESTION = (
    "Kaiser, mostre na tela o site example ponto com e me diga qual é o título da página."
)
NAME_QUESTION = "Kaiser, qual é o meu nome? Responda só o nome."
MUTE_REQUEST = "Kaiser, fique em silêncio agora, por favor."
UNMUTE_REQUEST = "Kaiser, pode voltar a falar e ligar o seu microfone."
SILENCE_CHECK_S = 12.0
TESTER_NAME = "Felipe"
SCREEN_TIMEOUT_S = 45.0
SCREEN_IDENTITY = "ai-screen"
SAMPLE_RATE = 24_000
SILENCE_RMS = 300.0


def _secret(name: str) -> str:
    value = read_secret(os.environ, name)
    assert value is not None
    return value.get_secret_value()


def _http_url(ws_url: str) -> str:
    return ws_url.replace("wss://", "https://", 1).replace("ws://", "http://", 1)


def _normalise(text: str) -> str:
    folded = unicodedata.normalize("NFKD", text.lower())
    return "".join(c for c in folded if not unicodedata.combining(c))


async def _poll(predicate: Callable[[], bool]) -> None:
    while not predicate():  # noqa: ASYNC110 - room state has no single event to await
        await asyncio.sleep(0.1)


async def _wait_for(predicate: Callable[[], bool], limit_s: float, what: str) -> None:
    try:
        await asyncio.wait_for(_poll(predicate), limit_s)
    except TimeoutError:
        raise TimeoutError(f"timed out waiting for {what}") from None


def _agent(room: rtc.Room) -> rtc.RemoteParticipant | None:
    for participant in room.remote_participants.values():
        if participant.kind == rtc.ParticipantKind.PARTICIPANT_KIND_AGENT:
            return participant
    return None


VOICE_TRACK = "roomio_audio"
THINKING_TRACK = "background_audio"


def _agent_audio(room: rtc.Room, name: str = VOICE_TRACK) -> rtc.RemoteTrackPublication | None:
    agent = _agent(room)
    if agent is None:
        return None
    for publication in agent.track_publications.values():
        if (
            publication.kind == rtc.TrackKind.KIND_AUDIO
            and publication.name == name
            and publication.track is not None
        ):
            return publication
    return None


async def _synthesise(question: str) -> list[rtc.AudioFrame]:
    # Outside an agent job the plugin has no shared HTTP session, so it gets its own.
    async with aiohttp.ClientSession() as http:
        tts = fishaudio.TTS(
            api_key=_secret("FISH_API_KEY"),
            model=os.environ.get("FISH_TTS_MODEL", "").strip() or "s2.1-pro",
            output_format="pcm",
            sample_rate=SAMPLE_RATE,
            http_session=http,
        )
        try:
            return [event.frame async for event in tts.synthesize(question)]
        finally:
            await tts.aclose()


async def _speak(source: rtc.AudioSource, frames: list[rtc.AudioFrame]) -> None:
    for frame in frames:
        await source.capture_frame(frame)
    silence = rtc.AudioFrame.create(SAMPLE_RATE, 1, SAMPLE_RATE // 100)
    for _ in range(150):  # 1.5 s of silence so the turn can end
        await source.capture_frame(silence)
    await source.wait_for_playout()


async def _first_voice_after(track: rtc.Track, started: Callable[[], float | None]) -> float:
    stream = rtc.AudioStream(track, sample_rate=SAMPLE_RATE)
    try:
        async for event in stream:
            t0 = started()
            if t0 is None:
                continue
            samples = np.frombuffer(event.frame.data, dtype=np.int16).astype(np.float32)
            if samples.size and float(np.sqrt(np.mean(samples**2))) > SILENCE_RMS:
                return time.monotonic() - t0
    finally:
        await stream.aclose()
    raise RuntimeError("agent audio stream ended")


async def _microphone(room: rtc.Room) -> rtc.AudioSource:
    source = rtc.AudioSource(SAMPLE_RATE, 1)
    track = rtc.LocalAudioTrack.create_audio_track("microfone", source)
    await room.local_participant.publish_track(
        track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
    )
    return source


def _screen_share(room: rtc.Room) -> rtc.RemoteTrackPublication | None:
    screen = room.remote_participants.get(SCREEN_IDENTITY)
    if screen is None:
        return None
    for publication in screen.track_publications.values():
        if (
            publication.source == rtc.TrackSource.SOURCE_SCREENSHARE
            and publication.track is not None
        ):
            return publication
    return None


def _collect_transcripts(room: rtc.Room) -> list[str]:
    transcripts: list[str] = []

    def on_transcript(reader: rtc.TextStreamReader, identity: str) -> None:
        async def collect() -> None:
            with contextlib.suppress(Exception):  # streams cut by the final disconnect
                transcripts.append(f"{identity}: {await reader.read_all()}")

        asyncio.ensure_future(collect())  # noqa: RUF006 - lives as long as the room

    room.register_text_stream_handler("lk.transcription", on_transcript)
    return transcripts


def _agent_lines(room: rtc.Room, transcripts: list[str]) -> list[str]:
    agent = _agent(room)
    prefix = f"{agent.identity}: " if agent else "\0"
    return [t.split(": ", 1)[1] for t in transcripts if t.startswith(prefix)]


async def _ask(
    room: rtc.Room,
    source: rtc.AudioSource,
    transcripts: list[str],
    question: str,
    *,
    until: Callable[[str], bool] = bool,
    limit_s: float = ANSWER_TIMEOUT_S,
) -> str:
    """Speaks a question and returns everything the agent said until ``until`` holds."""
    before = len(_agent_lines(room, transcripts))
    await _speak(source, await _synthesise(question))

    def answer() -> str:
        return " ".join(_agent_lines(room, transcripts)[before:])

    await _wait_for(lambda: until(answer()), limit_s, "agent answer")
    await asyncio.sleep(1.0)
    return answer()


async def _identity_conversation(
    room: rtc.Room, source: rtc.AudioSource, transcripts: list[str]
) -> dict[str, Any]:
    answer = await _ask(room, source, transcripts, NAME_QUESTION)
    assert "felipe" in _normalise(answer), answer
    return {"answer": answer}


async def _screen_conversation(
    room: rtc.Room, source: rtc.AudioSource, transcripts: list[str]
) -> dict[str, Any]:
    asked = time.monotonic()
    speaking = asyncio.create_task(
        _ask(
            room,
            source,
            transcripts,
            SCREEN_QUESTION,
            until=lambda a: "example" in _normalise(a),
            limit_s=SCREEN_TIMEOUT_S,
        )
    )
    await _wait_for(lambda: _screen_share(room) is not None, SCREEN_TIMEOUT_S, "AI screen share")
    publication = _screen_share(room)
    assert publication is not None
    assert publication.track is not None
    stream = rtc.VideoStream(publication.track)
    try:
        event = await asyncio.wait_for(anext(aiter(stream)), 15.0)
    finally:
        await stream.aclose()
    answer = await speaking
    return {
        "screen_after_s": round(time.monotonic() - asked, 1),
        "frame": f"{event.frame.width}x{event.frame.height}",
        "answer": answer,
    }


def _agent_muted(room: rtc.Room) -> bool:
    agent = _agent(room)
    return agent is not None and (agent.attributes or {}).get("impa.muted") == "true"


async def _mute_conversation(
    room: rtc.Room, source: rtc.AudioSource, transcripts: list[str]
) -> dict[str, Any]:
    await _speak(source, await _synthesise(MUTE_REQUEST))
    await _wait_for(lambda: _agent_muted(room), ANSWER_TIMEOUT_S, "agent muted")

    publication = _agent_audio(room)
    assert publication is not None
    assert publication.track is not None
    finished: dict[str, float] = {}
    listener = asyncio.create_task(_first_voice_after(publication.track, lambda: finished.get("t")))
    before = len(_agent_lines(room, transcripts))
    await _speak(source, await _synthesise(QUESTION))
    finished["t"] = time.monotonic()
    await asyncio.sleep(SILENCE_CHECK_S)
    spoke = listener.done() and not listener.cancelled() and listener.exception() is None
    listener.cancel()
    assert not spoke, "the muted agent produced audio"
    said = _agent_lines(room, transcripts)[before:]
    assert not said, said

    await _speak(source, await _synthesise(UNMUTE_REQUEST))
    await _wait_for(lambda: not _agent_muted(room), ANSWER_TIMEOUT_S, "agent unmuted")
    return {"silent_for_s": SILENCE_CHECK_S, "ignored_question": True}


async def _conversation(
    room: rtc.Room, source: rtc.AudioSource, transcripts: list[str]
) -> dict[str, Any]:
    frames = await _synthesise(QUESTION)

    publication = _agent_audio(room)
    assert publication is not None
    assert publication.track is not None
    finished_speaking: dict[str, float] = {}
    listener = asyncio.create_task(
        _first_voice_after(publication.track, lambda: finished_speaking.get("t"))
    )
    thinking = _agent_audio(room, THINKING_TRACK)
    thinking_listener = (
        asyncio.create_task(_first_voice_after(thinking.track, lambda: finished_speaking.get("t")))
        if thinking is not None and thinking.track is not None
        else None
    )

    agent = _agent(room)
    assert agent is not None

    def agent_lines() -> list[str]:
        return [t for t in transcripts if t.startswith(f"{agent.identity}: ")]

    await asyncio.sleep(GREETING_GRACE_S)  # let the greeting finish before asking
    before = len(agent_lines())
    await _speak(source, frames)
    finished_speaking["t"] = time.monotonic() - 1.5  # the trailing silence is not speech

    latency = await asyncio.wait_for(listener, ANSWER_TIMEOUT_S)
    thinking_s: float | None = None
    if thinking_listener is not None:
        if thinking_listener.done() and not thinking_listener.exception():
            thinking_s = round(thinking_listener.result(), 2)
        else:
            thinking_listener.cancel()
    await _wait_for(lambda: len(agent_lines()) > before, ANSWER_TIMEOUT_S, "agent answer")
    await asyncio.sleep(2.0)  # let the turn finish so its metrics are recorded
    answer = " ".join(line.split(": ", 1)[1] for line in agent_lines()[before:])
    heard = [t for t in transcripts if t.startswith("e2e-tester: ")]
    assert heard, "the agent did not transcribe the question"
    assert f"{TESTER_NAME} (" in heard[-1], f"the transcript does not name the speaker: {heard}"
    return {
        "thinking_sound_s": thinking_s,
        "answer_latency_s": round(latency, 2),
        "words": len(answer.split()),
        "heard": heard[-1:],
        "answer": answer,
    }


def _dispatch_metadata() -> str:
    """``E2E_AGENT_ID`` runs a platform agent (its integrations' keys) instead of the worker's."""
    agent_id = os.environ.get("E2E_AGENT_ID", "").strip()
    return json.dumps({"agentId": agent_id}) if agent_id else ""


def _token(key: str, secret: str, room: str, *, identity: str, name: str, role: str) -> str:
    return (
        api.AccessToken(key, secret)
        .with_identity(identity)
        .with_name(name)
        .with_attributes({"role": role})
        .with_grants(api.VideoGrants(room_join=True, room=room))
        .to_jwt()
    )


async def run(step: Callable[[str, Awaitable[Any]], Awaitable[Any]]) -> None:
    ws_url = os.environ["LIVEKIT_URL"]
    key, secret = _secret("LIVEKIT_API_KEY"), _secret("LIVEKIT_API_SECRET")
    room_name = f"e2e-{uuid.uuid4().hex[:8]}"
    guest_mode = os.environ.get("E2E_GUEST") == "1"

    lkapi = api.LiveKitAPI(url=_http_url(ws_url), api_key=key, api_secret=secret)
    room = rtc.Room()
    moderator = rtc.Room()
    try:
        await step("create room", lkapi.room.create_room(api.CreateRoomRequest(name=room_name)))
        if guest_mode:
            mod_token = _token(
                key, secret, room_name, identity="e2e-moderador", name="Moderador", role="moderator"
            )
            await step("silent moderator joins first", moderator.connect(ws_url, mod_token))
            await _microphone(moderator)  # publishes silence, like a muted-by-choice host
        await step(
            "dispatch agent",
            lkapi.agent_dispatch.create_dispatch(
                api.CreateAgentDispatchRequest(
                    agent_name=AGENT_NAME, room=room_name, metadata=_dispatch_metadata()
                )
            ),
        )
        if guest_mode:
            await step(
                "agent joins (moderator's view)",
                _wait_for(lambda: _agent(moderator) is not None, JOIN_TIMEOUT_S, "agent"),
            )
        role = "guest" if guest_mode else "participant"
        token = _token(key, secret, room_name, identity="e2e-tester", name=TESTER_NAME, role=role)
        transcripts = _collect_transcripts(room)
        await step(f"join as {role}", room.connect(ws_url, token))
        await step(
            "agent joins as AGENT",
            _wait_for(lambda: _agent(room) is not None, JOIN_TIMEOUT_S, "agent participant"),
        )
        await step(
            "agent publishes audio",
            _wait_for(lambda: _agent_audio(room) is not None, JOIN_TIMEOUT_S, "agent audio"),
        )
        if os.environ.get("E2E_CONVERSATION") == "1":
            source = await _microphone(room)
            result = await step(
                f"spoken question from the {role} gets a spoken answer",
                _conversation(room, source, transcripts),
            )
            assert "4" in result["answer"] or "quatro" in _normalise(result["answer"]), result
            await step(
                "the agent knows who is talking (by name)",
                _identity_conversation(room, source, transcripts),
            )
            if os.environ.get("E2E_SCREEN") == "1":
                await step(
                    "the AI shares a page by voice and reads what it shows",
                    _screen_conversation(room, source, transcripts),
                )
            if os.environ.get("E2E_MUTE") == "1":
                await step(
                    "told to be quiet, the AI stops speaking until asked back",
                    _mute_conversation(room, source, transcripts),
                )
    finally:
        await room.disconnect()
        await moderator.disconnect()
        await lkapi.room.delete_room(api.DeleteRoomRequest(room=room_name))
        await lkapi.aclose()


async def main() -> int:
    failures = 0

    async def step(name: str, awaitable: Awaitable[Any]) -> Any:
        nonlocal failures
        started = time.monotonic()
        try:
            result = await awaitable
        except Exception as exc:
            failures += 1
            print(f"FAIL {name} ({time.monotonic() - started:.1f}s): {exc!r}", flush=True)
            raise
        print(f"PASS {name} ({time.monotonic() - started:.1f}s) {result or ''}", flush=True)
        return result

    try:
        await run(step)
    except Exception:
        failures = max(failures, 1)
    print("E2E RESULT:", "PASS" if failures == 0 else "FAIL", flush=True)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
