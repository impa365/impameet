from __future__ import annotations

import os
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from meet_impar_agent import redaction
from meet_impar_agent.config import get_settings

LIVEKIT_KEY = "lk-key-0123456789"
LIVEKIT_SECRET = "lk-secret-abcdefghijklmnopqrstuvwxyz"
FISH_KEY = "fish-key-9876543210"
LLM_KEY = "llm-key-zyxwvutsrq"
# How a test agent thinks and sounds (each agent chooses these on the platform).
TUNING: dict[str, Any] = {
    "llm_temperature": 0.6,
    "llm_max_tokens": 400,
    "llm_timeout_s": 15.0,
    "thinking_volume": 0.5,
    "tts_latency": "balanced",
}


@pytest.fixture
def env(tmp_path: Path) -> dict[str, str]:
    """A complete, valid environment with secrets delivered as files."""

    def secret_file(name: str, value: str) -> str:
        path = tmp_path / name
        path.write_text(value + "\n", encoding="utf-8")
        return str(path)

    return {
        "LIVEKIT_URL": "wss://livekit.example.com",
        "LIVEKIT_API_KEY_FILE": secret_file("livekit_api_key", LIVEKIT_KEY),
        "LIVEKIT_API_SECRET_FILE": secret_file("livekit_api_secret", LIVEKIT_SECRET),
        "AGENT_NAME": "kaiser",
    }


_exit_status: list[int] = []


@pytest.hookimpl(trylast=True)
def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    _exit_status.append(int(exitstatus))


@pytest.hookimpl(trylast=True)
def pytest_unconfigure(config: pytest.Config) -> None:
    """The LiveKit native runtime can panic while Python tears its threads down, after every
    result is final; leave with the real status instead of running native destructors."""
    if _exit_status:
        config.get_terminal_writer().flush()
        for stream in (sys.stdout, sys.stderr, sys.__stdout__, sys.__stderr__):
            if stream is not None:
                stream.flush()
        os._exit(_exit_status[-1])


@pytest.fixture(autouse=True)
def _isolate_process_state() -> Iterator[None]:
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()
    redaction.uninstall()
