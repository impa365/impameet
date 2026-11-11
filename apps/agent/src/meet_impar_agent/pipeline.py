"""Builds the voice pipeline (STT -> LLM -> TTS) from the agent's own choices.

Each builder is a pure function of what the agent chose on the platform, so providers can be
swapped by configuration alone and every wiring decision is unit-testable without a network.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, Final

from livekit.agents import (
    APIConnectOptions,
    AudioConfig,
    BackgroundAudioPlayer,
    BuiltinAudioClip,
    SessionConnectOptions,
    TurnHandlingOptions,
    stt,
    tts,
)
from livekit.plugins import deepgram, elevenlabs, fishaudio, openai

from .profile import TtsLatency
from .providers import DEEPGRAM_MULTILINGUAL_STT, SpeechProvider

FISH_API_URL = "https://api.fish.audio"
FISH_SAMPLE_RATE = 24_000
"""PCM keeps decoding off the hot path; Fish refuses 48 kHz PCM, 24 kHz is plenty for voice."""
TTS_SAMPLE_RATE = 24_000
ELEVENLABS_ENCODING: Final = "pcm_24000"
# Flux starts the reply on an "eager" end of turn and confirms it at the regular one.
DEEPGRAM_EAGER_EOT = 0.5
DEEPGRAM_EOT = 0.75


def _base_url(url: object) -> str:
    return str(url).rstrip("/")


def build_stt(
    provider: SpeechProvider,
    *,
    api_key: str,
    model: str,
    languages: Sequence[str] = (),
) -> stt.STT[Any]:
    """The agent's own transcription account and model (never the worker's).

    Every provider here streams over a WebSocket and decides the end of each turn, which is
    what `build_turn_handling` relies on. `languages` are the ones the agent answers in.
    """
    if provider == "deepgram":
        hints = list(languages) if model == DEEPGRAM_MULTILINGUAL_STT and languages else None
        kwargs: dict[str, Any] = {
            "model": model,
            "api_key": api_key,
            "eager_eot_threshold": DEEPGRAM_EAGER_EOT,
            "eot_threshold": DEEPGRAM_EOT,
        }
        if hints:
            kwargs["language_hint"] = hints
        return deepgram.STTv2(**kwargs)
    if provider == "elevenlabs":
        # Server-side VAD commits each utterance, so the provider marks the end of turn.
        return elevenlabs.STT(api_key=api_key, model=model, server_vad={}, tag_audio_events=False)
    return fishaudio.STT(
        api_key=api_key,
        base_url=FISH_API_URL,
        model=model,
        turn_detection_mode="auto",
    )


def build_tts(
    provider: SpeechProvider,
    *,
    voice_id: str,
    model: str,
    api_key: str,
    latency: TtsLatency | None,
) -> tts.TTS[Any]:
    """The agent's own voice, speech model and account (never the worker's).

    ``latency`` is Fish Audio's, chosen in the agent (required with Fish, unused otherwise).
    """
    if provider == "deepgram":
        # Deepgram voices are model names: "flux-…" streams on /v2/speak, "aura-2-…" on /v1/speak.
        if model == "flux":
            return deepgram.TTSv2(model=voice_id, api_key=api_key, sample_rate=TTS_SAMPLE_RATE)
        return deepgram.TTS(model=voice_id, api_key=api_key, sample_rate=TTS_SAMPLE_RATE)
    if provider == "elevenlabs":
        return elevenlabs.TTS(
            voice_id=voice_id, model=model, api_key=api_key, encoding=ELEVENLABS_ENCODING
        )
    if latency is None:
        raise ValueError("a Fish Audio voice needs the latency chosen in the agent")
    return fishaudio.TTS(
        api_key=api_key,
        base_url=FISH_API_URL,
        model=model,
        voice_id=voice_id,
        latency_mode=latency,
        output_format="pcm",
        sample_rate=FISH_SAMPLE_RATE,
    )


def build_llm(
    *, model: str, base_url: str, api_key: str, temperature: float, max_tokens: int
) -> openai.LLM:
    """The agent's own OpenAI-compatible endpoint, key, model and tuning (never the worker's)."""
    return openai.LLM(
        model=model,
        base_url=_base_url(base_url),
        api_key=api_key,
        temperature=temperature,
        max_completion_tokens=max_tokens,
        max_retries=0,
    )


def build_conn_options(timeout_s: float) -> SessionConnectOptions:
    """Per-request deadlines; LiveKit applies these, not the HTTP client's own timeout."""
    return SessionConnectOptions(
        llm_conn_options=APIConnectOptions(
            max_retry=1, retry_interval=0.5, timeout=timeout_s, liveness_timeout=timeout_s
        ),
    )


class ThinkingAudio(BackgroundAudioPlayer):
    """The typing sound, switched on or off per room, also while the meeting runs."""

    def __init__(self, *, enabled: bool, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.enabled = enabled

    def set_enabled(self, enabled: bool) -> None:
        self.enabled = enabled
        if not enabled and self._thinking_handle:
            self._thinking_handle.stop()

    def _agent_state_changed(self, ev: Any) -> None:
        if self.enabled:
            super()._agent_state_changed(ev)
        elif self._thinking_handle:
            self._thinking_handle.stop()


def build_thinking_audio(volume: float, *, enabled: bool) -> ThinkingAudio | None:
    """Soft keyboard typing while the LLM works, so the wait never sounds like dead air.

    ``volume`` is the agent's (0 turns the feature off); ``enabled`` is the room's own switch,
    which can still change during the meeting (``ThinkingAudio.set_enabled``).
    """
    if volume == 0:
        return None
    return ThinkingAudio(
        enabled=enabled,
        thinking_sound=[
            AudioConfig(BuiltinAudioClip.KEYBOARD_TYPING, volume=volume),
            AudioConfig(BuiltinAudioClip.KEYBOARD_TYPING2, volume=volume),
        ],
    )


def build_turn_handling() -> TurnHandlingOptions:
    """The STT decides the end of each turn; the LLM starts on its eager end-of-turn signal.

    The agent's speech is not interruptible by voice activity (see ``bargein``), but the
    audio keeps flowing to the STT while it speaks, so a complete sentence can still stop it.
    """
    return TurnHandlingOptions(
        turn_detection="stt",
        interruption={
            "discard_audio_if_uninterruptible": False,
            "resume_false_interruption": True,
            "false_interruption_timeout": 1.0,
        },
        preemptive_generation={"enabled": True, "max_retries": 3},
    )
