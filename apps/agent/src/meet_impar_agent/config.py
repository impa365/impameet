"""Typed, validated runtime configuration.

Every value comes from the process environment. Secrets are read from the file named by
``<NAME>_FILE`` (Docker/Swarm secrets mounted on tmpfs) and fall back to ``<NAME>`` only
for local development. Secret values are wrapped in ``SecretStr`` so they never show up in
``repr``, logs or tracebacks.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal

from pydantic import (
    AnyHttpUrl,
    AnyWebsocketUrl,
    BaseModel,
    ConfigDict,
    Field,
    SecretStr,
    ValidationError,
)

MAX_SECRET_BYTES = 8 * 1024


class ConfigError(RuntimeError):
    """Raised when the environment does not describe a valid agent configuration."""


def read_secret(env: Mapping[str, str], name: str, *, required: bool = True) -> SecretStr | None:
    """Return the secret ``name`` from ``<name>_FILE`` or, failing that, from ``<name>``."""
    file_var = f"{name}_FILE"
    if file_path := env.get(file_var):
        path = Path(file_path)
        try:
            raw = path.read_bytes()
        except OSError as exc:
            raise ConfigError(f"{file_var} points to an unreadable file") from exc
        if len(raw) > MAX_SECRET_BYTES:
            raise ConfigError(f"{file_var} is larger than {MAX_SECRET_BYTES} bytes")
        value = raw.decode("utf-8").strip()
    else:
        value = env.get(name, "").strip()

    if not value:
        if required:
            raise ConfigError(f"missing secret: set {file_var} (preferred) or {name}")
        return None
    return SecretStr(value)


_Frozen = ConfigDict(frozen=True, extra="forbid")


class LiveKitSettings(BaseModel):
    model_config = _Frozen

    url: AnyWebsocketUrl
    api_key: SecretStr
    api_secret: SecretStr


class FishSettings(BaseModel):
    """How the worker talks to Fish Audio. Keys, models and voices belong to each agent."""

    model_config = _Frozen

    base_url: AnyHttpUrl = AnyHttpUrl("https://api.fish.audio")
    latency_mode: Literal["low", "balanced", "normal"] = "balanced"
    speed: Annotated[float, Field(ge=0.5, le=2.0)] | None = None


class LLMSettings(BaseModel):
    """Request tuning only. Endpoint, key and model belong to each agent."""

    model_config = _Frozen

    temperature: Annotated[float, Field(ge=0.0, le=2.0)] = 0.6
    max_completion_tokens: Annotated[int, Field(ge=16, le=8192)] = 400
    timeout_s: Annotated[float, Field(gt=0, le=120)] = 15.0


class AgentSettings(BaseModel):
    model_config = _Frozen

    # The dispatch name the platform asks for (its AGENT_NAME must match).
    name: Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9_-]{0,62}$")] = "kaiser"
    thinking_sound: bool = True
    thinking_volume: Annotated[float, Field(ge=0.0, le=1.0)] = 0.5


class PlatformSettings(BaseModel):
    """The IMPA Meet platform that stores per-room agent configurations."""

    model_config = _Frozen

    url: AnyHttpUrl
    token: SecretStr


class ScreenSettings(BaseModel):
    """The optional service that lets the agent share a screen in the room."""

    model_config = _Frozen

    url: AnyHttpUrl
    token: SecretStr


class Settings(BaseModel):
    model_config = _Frozen

    livekit: LiveKitSettings
    fish: FishSettings = FishSettings()
    llm: LLMSettings = LLMSettings()
    agent: AgentSettings = AgentSettings()
    platform: PlatformSettings | None = None
    screen: ScreenSettings | None = None
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"

    def secret_values(self) -> list[str]:
        """Every secret in this configuration, for log redaction."""
        secrets = [self.livekit.api_key, self.livekit.api_secret]
        if self.platform:
            secrets.append(self.platform.token)
        if self.screen:
            secrets.append(self.screen.token)
        return [s.get_secret_value() for s in secrets]


_TRUE = {"1", "true", "on", "sim", "yes"}
_FALSE = {"0", "false", "off", "nao", "não", "no"}


def _flag(env: Mapping[str, str], name: str) -> bool | None:
    value = _optional(env, name)
    if value is None:
        return None
    if value.lower() in _TRUE:
        return True
    if value.lower() in _FALSE:
        return False
    raise ConfigError(f"invalid configuration: {name} must be on or off")


def _optional(env: Mapping[str, str], name: str) -> str | None:
    value = env.get(name, "").strip()
    return value or None


def _service(env: Mapping[str, str], prefix: str) -> dict[str, object] | None:
    """Optional service: only when ``<prefix>_URL`` is set, and then its token is required."""
    url = _optional(env, f"{prefix}_URL")
    if not url:
        return None
    return {"url": url, "token": read_secret(env, f"{prefix}_TOKEN")}


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    """Build and validate :class:`Settings` from ``env`` (defaults to ``os.environ``)."""
    env = os.environ if env is None else env

    raw: dict[str, object] = {
        "livekit": {
            "url": _optional(env, "LIVEKIT_URL"),
            "api_key": read_secret(env, "LIVEKIT_API_KEY"),
            "api_secret": read_secret(env, "LIVEKIT_API_SECRET"),
        },
        "fish": {
            "base_url": _optional(env, "FISH_BASE_URL"),
            "latency_mode": _optional(env, "FISH_LATENCY_MODE"),
            "speed": _optional(env, "FISH_SPEED"),
        },
        "llm": {
            "temperature": _optional(env, "LLM_TEMPERATURE"),
            "max_completion_tokens": _optional(env, "LLM_MAX_COMPLETION_TOKENS"),
            "timeout_s": _optional(env, "LLM_TIMEOUT_S"),
        },
        "agent": {
            "name": _optional(env, "AGENT_NAME"),
            "thinking_sound": _flag(env, "AGENT_THINKING_SOUND"),
            "thinking_volume": _optional(env, "AGENT_THINKING_VOLUME"),
        },
        "platform": _service(env, "PLATFORM"),
        "screen": _service(env, "SCREEN"),
        "log_level": _optional(env, "LOG_LEVEL"),
    }

    try:
        return Settings.model_validate(_drop_unset(raw))
    except ValidationError as exc:
        fields = ", ".join(".".join(str(p) for p in err["loc"]) for err in exc.errors())
        raise ConfigError(f"invalid configuration: {fields}") from None


def _drop_unset(value: object) -> object:
    """Remove ``None`` entries so model defaults apply to unset variables."""
    if isinstance(value, dict):
        return {k: _drop_unset(v) for k, v in value.items() if v is not None}
    return value


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Process-wide settings, loaded once per (job) process."""
    return load_settings()
