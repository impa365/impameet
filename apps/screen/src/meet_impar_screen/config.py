"""Runtime configuration. Secrets come from ``<NAME>_FILE`` (Swarm secrets) or ``<NAME>``."""

from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path
from typing import Annotated

from pydantic import AnyWebsocketUrl, BaseModel, ConfigDict, Field, SecretStr, ValidationError

MAX_SECRET_BYTES = 8 * 1024


class ConfigError(RuntimeError):
    """Raised when the environment does not describe a valid configuration."""


def read_secret(env: Mapping[str, str], name: str) -> SecretStr:
    file_var = f"{name}_FILE"
    if file_path := env.get(file_var):
        try:
            raw = Path(file_path).read_bytes()
        except OSError as exc:
            raise ConfigError(f"{file_var} points to an unreadable file") from exc
        if len(raw) > MAX_SECRET_BYTES:
            raise ConfigError(f"{file_var} is larger than {MAX_SECRET_BYTES} bytes")
        value = raw.decode("utf-8").strip()
    else:
        value = env.get(name, "").strip()
    if not value:
        raise ConfigError(f"missing secret: set {file_var} (preferred) or {name}")
    return SecretStr(value)


class Settings(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    livekit_url: AnyWebsocketUrl
    livekit_api_key: SecretStr
    livekit_api_secret: SecretStr
    token: SecretStr
    port: Annotated[int, Field(ge=1, le=65535)] = 8090
    width: Annotated[int, Field(ge=320, le=1920)] = 1280
    height: Annotated[int, Field(ge=240, le=1080)] = 720
    max_sessions: Annotated[int, Field(ge=1, le=32)] = 4
    idle_timeout_s: Annotated[float, Field(gt=0)] = 1800.0
    display_name: Annotated[str, Field(min_length=1, max_length=64)] = "Tela da IA"

    def secret_values(self) -> list[str]:
        return [
            s.get_secret_value()
            for s in (self.livekit_api_key, self.livekit_api_secret, self.token)
        ]


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    env = os.environ if env is None else env
    optional = {
        "port": "SCREEN_PORT",
        "width": "SCREEN_WIDTH",
        "height": "SCREEN_HEIGHT",
        "max_sessions": "SCREEN_MAX_SESSIONS",
        "idle_timeout_s": "SCREEN_IDLE_TIMEOUT_S",
        "display_name": "SCREEN_DISPLAY_NAME",
    }
    raw: dict[str, object] = {
        "livekit_url": env.get("LIVEKIT_URL", "").strip() or None,
        "livekit_api_key": read_secret(env, "LIVEKIT_API_KEY"),
        "livekit_api_secret": read_secret(env, "LIVEKIT_API_SECRET"),
        "token": read_secret(env, "SCREEN_TOKEN"),
    }
    for field, var in optional.items():
        if value := env.get(var, "").strip():
            raw[field] = value
    try:
        return Settings.model_validate(raw)
    except ValidationError as exc:
        fields = ", ".join(".".join(str(p) for p in err["loc"]) for err in exc.errors())
        raise ConfigError(f"invalid configuration: {fields}") from None
