"""Builds the voice pipeline (STT -> LLM -> TTS) from :class:`Settings`.

Each builder is a pure function of the settings so providers can be swapped by
configuration alone and every wiring decision is unit-testable without a network.
"""

from __future__ import annotations

from typing import Any

from livekit.agents import (
    APIConnectOptions,
    AudioConfig,
    BackgroundAudioPlayer,
    BuiltinAudioClip,
    SessionConnectOptions,
    TurnHandlingOptions,
)
from livekit.plugins import fishaudio, openai

from .config import AgentSettings, FishSettings, LLMSettings

FISH_SAMPLE_RATE = 24_000
"""PCM keeps decoding off the hot path; Fish refuses 48 kHz PCM, 24 kHz is plenty for voice."""


def _base_url(url: object) -> str:
    return str(url).rstrip("/")


def build_stt(fish: FishSettings, *, api_key: str, model: str) -> fishaudio.STT:
    """The agent's own Fish Audio account and transcription model (never the worker's)."""
    return fishaudio.STT(
        api_key=api_key,
        base_url=_base_url(fish.base_url),
        model=model,
        turn_detection_mode="auto",
    )


def build_tts(fish: FishSettings, *, voice_id: str, model: str, api_key: str) -> fishaudio.TTS:
    """The agent's own voice, speech model and Fish Audio account (never the worker's)."""
    kwargs: dict[str, Any] = {
        "api_key": api_key,
        "base_url": _base_url(fish.base_url),
        "model": model,
        "voice_id": voice_id,
        "latency_mode": fish.latency_mode,
        "output_format": "pcm",
        "sample_rate": FISH_SAMPLE_RATE,
    }
    if fish.speed is not None:
        kwargs["speed"] = fish.speed
    return fishaudio.TTS(**kwargs)


def build_llm(llm: LLMSettings, *, model: str, base_url: str, api_key: str) -> openai.LLM:
    """The agent's own OpenAI-compatible endpoint, key and model (never the worker's).

    Only tuning (temperature, answer length, timeouts) comes from the worker settings.
    """
    return openai.LLM(
        model=model,
        base_url=_base_url(base_url),
        api_key=api_key,
        temperature=llm.temperature,
        max_completion_tokens=llm.max_completion_tokens,
        max_retries=0,
    )


def build_conn_options(llm: LLMSettings) -> SessionConnectOptions:
    """Per-request deadlines; LiveKit applies these, not the HTTP client's own timeout."""
    return SessionConnectOptions(
        llm_conn_options=APIConnectOptions(
            max_retry=1, retry_interval=0.5, timeout=llm.timeout_s, liveness_timeout=llm.timeout_s
        ),
    )


def build_thinking_audio(agent: AgentSettings) -> BackgroundAudioPlayer | None:
    """Soft keyboard typing while the LLM works, so the wait never sounds like dead air."""
    if not agent.thinking_sound or agent.thinking_volume == 0:
        return None
    return BackgroundAudioPlayer(
        thinking_sound=[
            AudioConfig(BuiltinAudioClip.KEYBOARD_TYPING, volume=agent.thinking_volume),
            AudioConfig(BuiltinAudioClip.KEYBOARD_TYPING2, volume=agent.thinking_volume),
        ],
    )


def build_turn_handling() -> TurnHandlingOptions:
    """Fish decides end of turn; the LLM starts on Fish's eager end-of-turn signal."""
    return TurnHandlingOptions(
        turn_detection="stt",
        interruption={
            "resume_false_interruption": True,
            "false_interruption_timeout": 1.0,
        },
        preemptive_generation={"enabled": True, "max_retries": 3},
    )
