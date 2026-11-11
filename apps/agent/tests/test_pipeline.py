from __future__ import annotations

import pytest
from livekit.agents import BackgroundAudioPlayer, BuiltinAudioClip
from livekit.plugins import deepgram, elevenlabs, fishaudio, openai

from meet_impar_agent.pipeline import (
    ELEVENLABS_ENCODING,
    FISH_SAMPLE_RATE,
    TTS_SAMPLE_RATE,
    build_conn_options,
    build_llm,
    build_stt,
    build_thinking_audio,
    build_tts,
    build_turn_handling,
)
from meet_impar_agent.providers import voice_options

from .conftest import FISH_KEY, LLM_KEY

DEEPGRAM_KEY = "dg-test-0123456789"
ELEVEN_KEY = "el-test-0123456789"


def test_stt_uses_fish_realtime_with_server_turn_detection() -> None:
    stt = build_stt("fish", api_key=FISH_KEY, model="transcribe-stream-1")

    assert isinstance(stt, fishaudio.STT)
    assert stt.model == "transcribe-stream-1"
    assert stt.capabilities.streaming
    assert stt._opts.turn_detection_mode == "auto"
    assert stt._opts.base_url == "https://api.fish.audio"
    assert stt._api_key == FISH_KEY


@pytest.mark.parametrize("latency", ["low", "balanced", "normal"])
def test_tts_streams_pcm_with_the_agent_voice_and_latency(latency: str) -> None:
    tts = build_tts(
        "fish",
        voice_id="voice-123",
        model="drama-3",
        api_key=FISH_KEY,
        latency=latency,  # type: ignore[arg-type]
    )

    assert isinstance(tts, fishaudio.TTS)
    assert tts.capabilities.streaming
    assert tts.sample_rate == FISH_SAMPLE_RATE
    assert tts._opts.model == "drama-3"
    assert tts._opts.output_format == "pcm"
    assert tts._opts.voice_id == "voice-123"
    assert tts._opts.latency_mode == latency
    assert tts._opts.api_key == FISH_KEY
    assert tts._opts.get_ws_url("/v1/tts/live") == "wss://api.fish.audio/v1/tts/live"


def test_a_fish_voice_without_the_agent_latency_is_refused() -> None:
    with pytest.raises(ValueError, match="latency"):
        build_tts("fish", voice_id="voice-123", model="s2.1-pro", api_key=FISH_KEY, latency=None)


def test_deepgram_flux_listens_in_the_agent_languages() -> None:
    stt = build_stt(
        "deepgram", api_key=DEEPGRAM_KEY, model="flux-general-multi", languages=("pt", "es")
    )

    assert isinstance(stt, deepgram.STTv2)
    assert stt.capabilities.streaming
    assert stt._opts.model == "flux-general-multi"
    assert stt._opts.language_hint == ["pt", "es"]
    assert stt._opts.endpoint_url == "wss://api.deepgram.com/v2/listen"
    assert stt._opts.eager_eot_threshold == pytest.approx(0.5)
    assert stt._api_key == DEEPGRAM_KEY

    english = build_stt(
        "deepgram", api_key=DEEPGRAM_KEY, model="flux-general-en", languages=("en",)
    )
    assert english._opts.language_hint == []  # only the multilingual model takes hints


def test_deepgram_speaks_with_flux_or_aura() -> None:
    flux = build_tts(
        "deepgram", voice_id="flux-bianca-pt", model="flux", api_key=DEEPGRAM_KEY, latency=None
    )
    assert isinstance(flux, deepgram.TTSv2)
    assert flux.sample_rate == TTS_SAMPLE_RATE
    assert flux._opts.model == "flux-bianca-pt"
    assert flux._opts.api_key == DEEPGRAM_KEY

    aura = build_tts(
        "deepgram", voice_id="aura-2-celeste-es", model="aura-2", api_key=DEEPGRAM_KEY, latency=None
    )
    assert isinstance(aura, deepgram.TTS)
    assert aura._opts.model == "aura-2-celeste-es"


def test_elevenlabs_listens_in_realtime_and_speaks_pcm() -> None:
    stt = build_stt("elevenlabs", api_key=ELEVEN_KEY, model="scribe_v2_realtime")
    assert isinstance(stt, elevenlabs.STT)
    assert stt.capabilities.streaming
    assert stt._opts.api_key == ELEVEN_KEY

    tts = build_tts(
        "elevenlabs",
        voice_id="EXAVITQu4vr4xnSDxMaL",
        model="eleven_flash_v2_5",
        api_key=ELEVEN_KEY,
        latency=None,
    )
    assert isinstance(tts, elevenlabs.TTS)
    assert tts._opts.voice_id == "EXAVITQu4vr4xnSDxMaL"
    assert tts._opts.model == "eleven_flash_v2_5"
    assert tts._opts.encoding == ELEVENLABS_ENCODING
    assert tts._opts.api_key == ELEVEN_KEY


def test_any_listening_provider_pairs_with_any_speaking_one() -> None:
    listening = build_stt("deepgram", api_key=DEEPGRAM_KEY, model="flux-general-multi")
    speaking = build_tts(
        "elevenlabs",
        voice_id="EXAVITQu4vr4xnSDxMaL",
        model="eleven_flash_v2_5",
        api_key=ELEVEN_KEY,
        latency=None,
    )
    assert isinstance(listening, deepgram.STTv2)
    assert isinstance(speaking, elevenlabs.TTS)


@pytest.mark.parametrize(
    ("provider", "expected"),
    [
        ("fish", {"voice_id": "v-pt"}),
        ("deepgram", {"model": "v-pt"}),
        ("elevenlabs", {"voice_id": "v-pt", "language": "pt"}),
    ],
)
def test_each_provider_switches_voice_its_own_way(provider: str, expected: dict[str, str]) -> None:
    assert voice_options(provider, "v-pt", "pt") == expected  # type: ignore[arg-type]


def test_llm_targets_the_agent_endpoint_with_its_tuning() -> None:
    llm = build_llm(
        model="qwen3.8-27b",
        base_url="https://llm.example.com/v1/",
        api_key=LLM_KEY,
        temperature=0.2,
        max_tokens=256,
    )

    assert isinstance(llm, openai.LLM)
    assert llm.model == "qwen3.8-27b"
    assert str(llm._client.base_url).rstrip("/") == "https://llm.example.com/v1"
    assert llm._client.api_key == LLM_KEY
    assert llm._client.max_retries == 0
    assert llm._opts.temperature == pytest.approx(0.2)
    assert llm._opts.max_completion_tokens == 256


def test_llm_deadline_comes_from_session_connect_options() -> None:
    options = build_conn_options(3).llm_conn_options

    assert options.timeout == pytest.approx(3)
    assert options.liveness_timeout == pytest.approx(3)
    assert options.max_retry == 1


async def test_thinking_audio_plays_soft_typing_at_the_agent_volume() -> None:
    player = build_thinking_audio(0.4, enabled=True)

    assert isinstance(player, BackgroundAudioPlayer)
    try:
        sounds = player._thinking_sound
        assert isinstance(sounds, list)
        assert [s.source for s in sounds] == [
            BuiltinAudioClip.KEYBOARD_TYPING,
            BuiltinAudioClip.KEYBOARD_TYPING2,
        ]
        assert all(s.volume == pytest.approx(0.4) for s in sounds)
    finally:
        await player._audio_mixer.aclose()
        await player._audio_source.aclose()


def test_thinking_audio_is_off_at_volume_zero() -> None:
    assert build_thinking_audio(0, enabled=True) is None


def test_turn_handling_lets_fish_end_turns_and_starts_llm_early() -> None:
    options = build_turn_handling()

    assert options["turn_detection"] == "stt"
    assert options["preemptive_generation"]["enabled"] is True
    assert options["interruption"]["resume_false_interruption"] is True
