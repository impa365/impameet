from __future__ import annotations

import pytest
from livekit.agents import BackgroundAudioPlayer, BuiltinAudioClip
from livekit.plugins import fishaudio, openai

from meet_impar_agent.config import load_settings
from meet_impar_agent.pipeline import (
    FISH_SAMPLE_RATE,
    build_conn_options,
    build_llm,
    build_stt,
    build_thinking_audio,
    build_tts,
    build_turn_handling,
)

from .conftest import FISH_KEY, LLM_KEY


def test_stt_uses_fish_realtime_with_server_turn_detection(env: dict[str, str]) -> None:
    stt = build_stt(load_settings(env).fish, api_key=FISH_KEY, model="transcribe-stream-1")

    assert isinstance(stt, fishaudio.STT)
    assert stt.model == "transcribe-stream-1"
    assert stt.capabilities.streaming
    assert stt._opts.turn_detection_mode == "auto"
    assert stt._opts.base_url == "https://api.fish.audio"
    assert stt._api_key == FISH_KEY


def test_tts_streams_pcm_with_the_chosen_voice(env: dict[str, str]) -> None:
    env |= {"FISH_SPEED": "1.2", "FISH_LATENCY_MODE": "low"}
    tts = build_tts(
        load_settings(env).fish, voice_id="voice-123", model="drama-3", api_key=FISH_KEY
    )

    assert isinstance(tts, fishaudio.TTS)
    assert tts.capabilities.streaming
    assert tts.sample_rate == FISH_SAMPLE_RATE
    assert tts._opts.model == "drama-3"
    assert tts._opts.output_format == "pcm"
    assert tts._opts.voice_id == "voice-123"
    assert tts._opts.speed == pytest.approx(1.2)
    assert tts._opts.latency_mode == "low"
    assert tts._opts.api_key == FISH_KEY
    assert tts._opts.get_ws_url("/v1/tts/live") == "wss://api.fish.audio/v1/tts/live"


def test_custom_fish_endpoint_has_no_trailing_slash(env: dict[str, str]) -> None:
    env["FISH_BASE_URL"] = "https://fish-proxy.example.com/"
    fish = load_settings(env).fish

    tts = build_tts(fish, voice_id="voice-123", model="s2.1-pro", api_key=FISH_KEY)
    assert tts._opts.base_url == "https://fish-proxy.example.com"
    stt = build_stt(fish, api_key=FISH_KEY, model="transcribe-stream-1")
    assert stt._opts.base_url == "https://fish-proxy.example.com"


def test_llm_targets_the_chosen_openai_compatible_endpoint(env: dict[str, str]) -> None:
    llm = build_llm(
        load_settings(env).llm,
        model="qwen3.8-27b",
        base_url="https://llm.example.com/v1/",
        api_key=LLM_KEY,
    )

    assert isinstance(llm, openai.LLM)
    assert llm.model == "qwen3.8-27b"
    assert str(llm._client.base_url).rstrip("/") == "https://llm.example.com/v1"
    assert llm._client.api_key == LLM_KEY
    assert llm._client.max_retries == 0
    assert llm._opts.temperature == pytest.approx(0.6)
    assert llm._opts.max_completion_tokens == 400


def test_llm_deadline_comes_from_session_connect_options(env: dict[str, str]) -> None:
    env["LLM_TIMEOUT_S"] = "3"
    options = build_conn_options(load_settings(env).llm).llm_conn_options

    assert options.timeout == pytest.approx(3)
    assert options.liveness_timeout == pytest.approx(3)
    assert options.max_retry == 1


async def test_thinking_audio_plays_soft_typing(env: dict[str, str]) -> None:
    env["AGENT_THINKING_VOLUME"] = "0.4"
    player = build_thinking_audio(load_settings(env).agent)

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


@pytest.mark.parametrize(
    "overrides", [{"AGENT_THINKING_SOUND": "off"}, {"AGENT_THINKING_VOLUME": "0"}]
)
def test_thinking_audio_can_be_disabled(env: dict[str, str], overrides: dict[str, str]) -> None:
    env |= overrides

    assert build_thinking_audio(load_settings(env).agent) is None


def test_turn_handling_lets_fish_end_turns_and_starts_llm_early() -> None:
    options = build_turn_handling()

    assert options["turn_detection"] == "stt"
    assert options["preemptive_generation"]["enabled"] is True
    assert options["interruption"]["resume_false_interruption"] is True
