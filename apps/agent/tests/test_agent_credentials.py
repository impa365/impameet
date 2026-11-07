from __future__ import annotations

import json
import logging
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from meet_impar_agent import captions, profile, redaction
from meet_impar_agent.config import load_settings
from meet_impar_agent.pipeline import build_llm, build_stt, build_tts
from meet_impar_agent.profile import profile_from_platform

REMOTE: dict[str, Any] = {
    "name": "Ana",
    "instructions": "Seja breve.",
    "llmModel": "deepseek/deepseek-chat",
    "ttsModel": "s2.1-pro",
    "sttModel": "transcribe-stream-1",
    "voices": {"pt": "voz-ana-pt", "en": "voice-ana-en"},
    "llm": {
        "baseUrl": "https://openrouter.ai/api/v1",
        "apiKey": "sk-or-agent-0123456789",
        "model": "deepseek/deepseek-chat",
    },
    "tts": {"provider": "fish", "apiKey": "fish-agent-0123456789"},
    "stt": {"provider": "deepgram", "apiKey": "dg-agent-0123456789"},
}


def test_profile_carries_the_agent_choices_without_printing_keys() -> None:
    p = profile_from_platform(REMOTE)
    assert p is not None
    assert p.llm_base_url == "https://openrouter.ai/api/v1"
    assert p.llm_api_key == "sk-or-agent-0123456789"
    assert (p.tts_provider, p.tts_api_key) == ("fish", "fish-agent-0123456789")
    assert (p.stt_provider, p.stt_api_key) == ("deepgram", "dg-agent-0123456789")
    assert (p.llm_model, p.tts_model, p.stt_model) == (
        "deepseek/deepseek-chat",
        "s2.1-pro",
        "transcribe-stream-1",
    )
    assert p.voice_id == "voz-ana-pt"
    assert p.voices == {"pt": "voz-ana-pt", "en": "voice-ana-en"}
    assert p.secrets() == [
        "sk-or-agent-0123456789",
        "fish-agent-0123456789",
        "dg-agent-0123456789",
    ]
    assert "sk-or-agent" not in repr(p)
    assert "fish-agent" not in repr(p)
    assert "dg-agent" not in repr(p)


@pytest.mark.parametrize(
    "missing",
    [
        {"llm": None},
        {"llm": {"apiKey": "  ", "baseUrl": "https://x.example/v1"}},
        {"tts": "x"},
        {"stt": None},
        {"tts": {"provider": "azure", "apiKey": "k-0123456789"}},
        {"stt": {"provider": "deepgram", "apiKey": " "}},
        {"llmModel": ""},
        {"ttsModel": None},
        {"sttModel": None},
        {"voices": {}},
        {"voices": {"fr": "voix-1234"}},
    ],
)
def test_nothing_falls_back_to_the_server(missing: dict[str, Any]) -> None:
    assert profile_from_platform(REMOTE | missing) is None


def test_builders_use_only_what_the_agent_chose(env: dict[str, str]) -> None:
    settings = load_settings(env)
    own = build_llm(
        settings.llm,
        model="deepseek/deepseek-chat",
        base_url="https://openrouter.ai/api/v1/",
        api_key="sk-or-agent-0123456789",
    )
    assert own.model == "deepseek/deepseek-chat"
    assert str(own._client.base_url).rstrip("/") == "https://openrouter.ai/api/v1"
    assert own._client.api_key == "sk-or-agent-0123456789"

    fish = settings.fish
    tts = build_tts(
        "fish", fish, voice_id="voz-ana-pt", model="s2.1-pro", api_key="fish-agent-0123456789"
    )
    assert tts._opts.api_key == "fish-agent-0123456789"
    assert tts._opts.voice_id == "voz-ana-pt"
    assert tts._opts.model == "s2.1-pro"
    stt = build_stt("fish", fish, api_key="fish-agent-0123456789", model="transcribe-stream-1")
    assert stt._api_key == "fish-agent-0123456789"


class _Response:
    status = 200

    def __init__(self, body: dict[str, object]) -> None:
        self._body = body

    async def json(self) -> dict[str, object]:
        return self._body

    async def __aenter__(self) -> _Response:
        return self

    async def __aexit__(self, *_: object) -> None: ...


def _platform(monkeypatch: pytest.MonkeyPatch, body: dict[str, object]) -> None:
    session = MagicMock()
    session.__aenter__ = AsyncMock(return_value=session)
    session.__aexit__ = AsyncMock(return_value=None)
    session.get = MagicMock(return_value=_Response(body))
    monkeypatch.setattr(profile.aiohttp, "ClientSession", MagicMock(return_value=session))


async def test_loaded_keys_are_redacted_from_logs(
    env: dict[str, str], monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    settings = load_settings(
        {**env, "PLATFORM_URL": "http://platform:3000", "PLATFORM_TOKEN": "t" * 40}
    )
    redaction.install(settings.secret_values())
    _platform(monkeypatch, {"agent": REMOTE})

    loaded = await profile.load_profile(settings, json.dumps({"agentId": "a1"}))
    assert loaded is not None
    assert loaded.llm_api_key == "sk-or-agent-0123456789"
    with caplog.at_level(logging.INFO):
        logging.getLogger("test").info("using sk-or-agent-0123456789 and fish-agent-0123456789")
    assert "sk-or-agent" not in caplog.text
    assert "fish-agent" not in caplog.text
    assert redaction.REDACTED in caplog.text


async def test_an_unconfigured_agent_is_not_loaded(
    env: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = load_settings(
        {**env, "PLATFORM_URL": "http://platform:3000", "PLATFORM_TOKEN": "t" * 40}
    )
    _platform(monkeypatch, {"agent": REMOTE | {"voices": {}}})
    assert await profile.load_profile(settings, json.dumps({"agentId": "a1"})) is None
    assert await profile.load_profile(settings, None) is None
    assert await profile.load_profile(load_settings(env), json.dumps({"agentId": "a1"})) is None


async def test_captions_transcribe_with_the_room_agent_account_and_model(
    env: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = load_settings(env)
    agent = profile_from_platform(REMOTE)
    monkeypatch.setattr(captions, "load_profile", AsyncMock(return_value=agent))
    built: list[tuple[str, str, str]] = []

    def fake_stt(provider: str, fish: object, *, api_key: str, model: str, **_: object) -> object:
        built.append((provider, api_key, model))
        return MagicMock()

    monkeypatch.setattr(captions, "build_stt", fake_stt)
    monkeypatch.setattr(captions, "save_transcript", AsyncMock())
    room = MagicMock()
    room.local_participant.set_attributes = AsyncMock()
    room.remote_participants = {}
    ctx = MagicMock(room=room, connect=AsyncMock())
    ctx.job.metadata = json.dumps({"mode": "captions", "agentId": "a1"})

    await captions.run_captions(ctx, settings)
    assert built == [("deepgram", "dg-agent-0123456789", "transcribe-stream-1")]
    captions.load_profile.assert_awaited_once_with(settings, ctx.job.metadata)


async def test_captions_stay_out_without_a_configured_agent(
    env: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(captions, "load_profile", AsyncMock(return_value=None))
    ctx = MagicMock(connect=AsyncMock())
    await captions.run_captions(ctx, load_settings(env))
    ctx.connect.assert_not_awaited()
    ctx.shutdown.assert_called_once()
