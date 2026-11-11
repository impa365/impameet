from __future__ import annotations

from pathlib import Path

import pytest

from meet_impar_agent.config import (
    MAX_SECRET_BYTES,
    ConfigError,
    Settings,
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


def test_the_worker_only_knows_where_to_connect(env: dict[str, str]) -> None:
    """Providers, keys, models, voices and their tuning are chosen per agent, never here."""
    settings = load_settings(env)

    assert set(Settings.model_fields) == {
        "livekit",
        "agent",
        "platform",
        "screen",
        "log_level",
    }
    assert set(type(settings.agent).model_fields) == {"name"}
    assert settings.agent.name == "kaiser"
    assert settings.log_level == "INFO"


@pytest.mark.parametrize(
    "variable",
    [
        "FISH_BASE_URL",
        "FISH_LATENCY_MODE",
        "FISH_SPEED",
        "FISH_TTS_MODEL",
        "FISH_VOICE_ID",
        "LLM_BASE_URL",
        "LLM_MODEL",
        "LLM_TEMPERATURE",
        "LLM_MAX_COMPLETION_TOKENS",
        "LLM_TIMEOUT_S",
        "AGENT_THINKING_SOUND",
        "AGENT_THINKING_VOLUME",
    ],
)
def test_agent_choices_in_the_environment_are_ignored(env: dict[str, str], variable: str) -> None:
    env[variable] = "anything"

    assert load_settings(env) == load_settings({k: v for k, v in env.items() if k != variable})


def test_overrides_are_applied(env: dict[str, str]) -> None:
    env |= {"AGENT_NAME": "impadmin", "LOG_LEVEL": "DEBUG"}
    settings = load_settings(env)

    assert settings.agent.name == "impadmin"
    assert settings.log_level == "DEBUG"


def test_the_dispatch_name_matches_the_platform_unless_both_change(env: dict[str, str]) -> None:
    del env["AGENT_NAME"]

    assert load_settings(env).agent.name == "kaiser"


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
        settings.agent.name = "other"  # type: ignore[misc]


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
