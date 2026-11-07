from __future__ import annotations

import logging
from typing import Any
from unittest.mock import MagicMock

import pytest
from livekit.agents import llm

from meet_impar_agent import telemetry
from meet_impar_agent.telemetry import turn_latency


class FakeSession:
    def __init__(self) -> None:
        self.handlers: dict[str, Any] = {}

    def on(self, event: str) -> Any:
        def register(fn: Any) -> Any:
            self.handlers[event] = fn
            return fn

        return register


@pytest.fixture
def session(caplog: pytest.LogCaptureFixture) -> FakeSession:
    caplog.set_level(logging.INFO, logger="meet_impar_agent.telemetry")
    fake = FakeSession()
    telemetry.attach(fake)  # type: ignore[arg-type]
    return fake


def test_turn_latency_keeps_known_numeric_fields_only() -> None:
    report = {
        "e2e_latency": 0.98765,
        "llm_node_ttft": 0.3,
        "tts_node_ttfb": None,
        "playback_latency": 0.1,
        "end_of_turn_delay": 1,
    }

    assert turn_latency(report) == {
        "e2e_latency": 0.988,
        "llm_node_ttft": 0.3,
        "end_of_turn_delay": 1.0,
    }


def test_turn_latency_of_an_empty_report() -> None:
    assert turn_latency({}) == {}


def test_agent_turns_log_latency_without_content(
    session: FakeSession, caplog: pytest.LogCaptureFixture
) -> None:
    message = llm.ChatMessage(
        role="assistant",
        content=["dado sigiloso do cliente"],
        metrics={"e2e_latency": 0.9, "llm_node_ttft": 0.25},
    )

    session.handlers["conversation_item_added"](MagicMock(item=message))

    [record] = caplog.records
    assert record.getMessage() == "agent turn"
    assert record.latency == {"e2e_latency": 0.9, "llm_node_ttft": 0.25}  # type: ignore[attr-defined]
    assert "sigiloso" not in caplog.text


def test_user_turns_and_turns_without_metrics_are_not_logged(
    session: FakeSession, caplog: pytest.LogCaptureFixture
) -> None:
    session.handlers["conversation_item_added"](
        MagicMock(item=llm.ChatMessage(role="user", content=["oi"], metrics={"e2e_latency": 1}))
    )
    session.handlers["conversation_item_added"](
        MagicMock(item=llm.ChatMessage(role="assistant", content=["oi"]))
    )
    session.handlers["conversation_item_added"](MagicMock(item=object()))

    assert caplog.records == []


def test_errors_log_types_not_messages(
    session: FakeSession, caplog: pytest.LogCaptureFixture
) -> None:
    session.handlers["error"](MagicMock(source=ValueError(), error=RuntimeError("detalhe")))

    [record] = caplog.records
    assert record.levelno == logging.WARNING
    assert record.source == "ValueError"  # type: ignore[attr-defined]
    assert record.error == "RuntimeError"  # type: ignore[attr-defined]
    assert "detalhe" not in caplog.text


def test_close_logs_the_reason(session: FakeSession, caplog: pytest.LogCaptureFixture) -> None:
    session.handlers["close"](MagicMock(reason="participant_disconnected"))

    [record] = caplog.records
    assert record.reason == "participant_disconnected"  # type: ignore[attr-defined]
