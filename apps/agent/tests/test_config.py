from __future__ import annotations

from pathlib import Path

import pytest

from meet_impar_agent.config import (
    MAX_SECRET_BYTES,
    ConfigError,
    get_settings,
    load_settings,
    read_secret,
)

from .conftest import LIVEKIT_KEY, LIVEKIT_SECRET


def test_loads_a_complete_environment(env: dict[str, str]) -> None:
    settings = load_settings(env)

    assert str(settings.livekit.url).startswith("wss://livekit.example.com")
    assert settings.livekit.api_key.get_secret_value() == LIVEKIT_KEY
    assert settings.livekit.api_secret.get_secret_value() == LIVEKIT_SECRET


def test_defaults_apply_to_unset_variables(env: dict[str, str]) -> None:
    settings = load_settings(env)

    assert str(settings.fish.base_url) == "https://api.fish.audio/"
    assert settings.fish.latency_mode == "balanced"
    assert settings.fish.speed is None
    assert settings.llm.temperature == pytest.approx(0.6)
    assert settings.llm.max_completion_tokens == 400
    assert settings.agent.name == "kaiser"
    assert settings.log_level == "INFO"


def test_no_provider_model_or_voice_is_configured_on_the_worker(env: dict[str, str]) -> None:
    """Keys, models and voices are chosen per agent on the platform, never here."""
    settings = load_settings(env)

    for section in (settings.fish, settings.llm, settings.agent):
        fields = set(type(section).model_fields)
        assert not fields & {"api_key", "model", "voice_id", "tts_model", "stt_model"}
        assert not fields & {"instructions", "greeting", "display_name", "language"}


def test_overrides_are_applied(env: dict[str, str]) -> None:
    env |= {
        "FISH_BASE_URL": "https://fish.example.com",
        "FISH_LATENCY_MODE": "low",
        "FISH_SPEED": "1.1",
        "LLM_TEMPERATURE": "0.2",
        "LLM_MAX_COMPLETION_TOKENS": "256",
        "LLM_TIMEOUT_S": "8",
        "AGENT_NAME": "impadmin",
        "LOG_LEVEL": "DEBUG",
    }
    settings = load_settings(env)

    assert str(settings.fish.base_url) == "https://fish.example.com/"
    assert settings.fish.latency_mode == "low"
    assert settings.fish.speed == pytest.approx(1.1)
    assert settings.llm.temperature == pytest.approx(0.2)
    assert settings.llm.max_completion_tokens == 256
    assert settings.llm.timeout_s == pytest.approx(8)
    assert settings.agent.name == "impadmin"
    assert settings.log_level == "DEBUG"


def test_thinking_sound_is_on_by_default(env: dict[str, str]) -> None:
    agent = load_settings(env).agent

    assert agent.thinking_sound is True
    assert agent.thinking_volume == pytest.approx(0.5)


@pytest.mark.parametrize(("value", "expected"), [("off", False), ("0", False), ("ON", True)])
def test_thinking_sound_flag(env: dict[str, str], value: str, expected: bool) -> None:
    env |= {"AGENT_THINKING_SOUND": value, "AGENT_THINKING_VOLUME": "0.3"}
    agent = load_settings(env).agent

    assert agent.thinking_sound is expected
    assert agent.thinking_volume == pytest.approx(0.3)


@pytest.mark.parametrize(
    ("variable", "value"), [("AGENT_THINKING_SOUND", "maybe"), ("AGENT_THINKING_VOLUME", "2")]
)
def test_invalid_thinking_settings(env: dict[str, str], variable: str, value: str) -> None:
    env[variable] = value

    with pytest.raises(ConfigError, match="invalid configuration"):
        load_settings(env)


@pytest.mark.parametrize("secret", ["LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"])
def test_every_secret_is_required(env: dict[str, str], secret: str) -> None:
    del env[f"{secret}_FILE"]

    with pytest.raises(ConfigError, match=secret):
        load_settings(env)


def test_livekit_url_is_required(env: dict[str, str]) -> None:
    del env["LIVEKIT_URL"]

    with pytest.raises(ConfigError, match="invalid configuration"):
        load_settings(env)


@pytest.mark.parametrize(
    ("variable", "value"),
    [
        ("LIVEKIT_URL", "https://not-a-websocket.example.com"),
        ("FISH_BASE_URL", "not a url"),
        ("FISH_LATENCY_MODE", "turbo"),
        ("FISH_SPEED", "3"),
        ("LLM_TEMPERATURE", "-1"),
        ("LLM_MAX_COMPLETION_TOKENS", "1"),
        ("LLM_TIMEOUT_S", "0"),
        ("AGENT_NAME", "Kaiser With Spaces"),
        ("LOG_LEVEL", "LOUD"),
    ],
)
def test_invalid_values_are_rejected(env: dict[str, str], variable: str, value: str) -> None:
    env[variable] = value

    with pytest.raises(ConfigError, match="invalid configuration"):
        load_settings(env)


def test_validation_errors_never_echo_secret_values(env: dict[str, str]) -> None:
    env["LIVEKIT_URL"] = "https://wrong.example.com"

    with pytest.raises(ConfigError) as info:
        load_settings(env)

    message = str(info.value)
    for secret in (LIVEKIT_KEY, LIVEKIT_SECRET):
        assert secret not in message
    assert info.value.__cause__ is None
    assert info.value.__suppress_context__


def test_secrets_are_hidden_in_repr(env: dict[str, str]) -> None:
    rendered = repr(load_settings(env)) + str(load_settings(env).model_dump())

    for secret in (LIVEKIT_KEY, LIVEKIT_SECRET):
        assert secret not in rendered


def test_secret_values_lists_every_secret(env: dict[str, str], tmp_path: Path) -> None:
    assert sorted(load_settings(env).secret_values()) == sorted([LIVEKIT_KEY, LIVEKIT_SECRET])

    token = tmp_path / "platform_token"
    token.write_text("platform-token-0123456789", encoding="utf-8")
    env |= {"PLATFORM_URL": "http://platform:3000", "PLATFORM_TOKEN_FILE": str(token)}
    assert "platform-token-0123456789" in load_settings(env).secret_values()


def test_settings_are_immutable(env: dict[str, str]) -> None:
    settings = load_settings(env)

    with pytest.raises(ValueError, match="frozen"):
        settings.llm.temperature = 1.0  # type: ignore[misc]


class TestReadSecret:
    def test_file_wins_over_plain_variable(self, tmp_path: Path) -> None:
        path = tmp_path / "s"
        path.write_text("from-file\n", encoding="utf-8")
        value = read_secret({"X_FILE": str(path), "X": "from-env"}, "X")

        assert value is not None
        assert value.get_secret_value() == "from-file"

    def test_plain_variable_for_local_development(self) -> None:
        value = read_secret({"X": "  dev-value  "}, "X")

        assert value is not None
        assert value.get_secret_value() == "dev-value"

    def test_optional_secret_may_be_missing(self) -> None:
        assert read_secret({}, "X", required=False) is None

    def test_blank_secret_is_missing(self, tmp_path: Path) -> None:
        path = tmp_path / "s"
        path.write_text("   \n", encoding="utf-8")

        with pytest.raises(ConfigError, match="missing secret"):
            read_secret({"X_FILE": str(path)}, "X")

    def test_unreadable_file(self, tmp_path: Path) -> None:
        with pytest.raises(ConfigError, match="unreadable"):
            read_secret({"X_FILE": str(tmp_path / "nope")}, "X")

    def test_oversized_file_is_rejected(self, tmp_path: Path) -> None:
        path = tmp_path / "s"
        path.write_bytes(b"a" * (MAX_SECRET_BYTES + 1))

        with pytest.raises(ConfigError, match="larger than"):
            read_secret({"X_FILE": str(path)}, "X")


def test_get_settings_reads_the_process_environment_once(
    env: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    for key, value in env.items():
        monkeypatch.setenv(key, value)

    first = get_settings()
    monkeypatch.setenv("AGENT_NAME", "changed")

    assert get_settings() is first
    assert first.agent.name == "kaiser"
