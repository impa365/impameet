"""Per-turn latency and session lifecycle logging. Conversation content is never logged."""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any

from livekit.agents import AgentSession, llm
from livekit.agents.voice.events import CloseEvent, ConversationItemAddedEvent, ErrorEvent

logger = logging.getLogger("meet_impar_agent.telemetry")

LATENCY_FIELDS = ("end_of_turn_delay", "llm_node_ttft", "tts_node_ttfb", "e2e_latency")


def turn_latency(metrics: Mapping[str, Any]) -> dict[str, float]:
    """The latency fields of a turn's metrics report, in seconds, rounded to milliseconds."""
    return {
        name: round(float(metrics[name]), 3)
        for name in LATENCY_FIELDS
        if isinstance(metrics.get(name), int | float)
    }


def attach(session: AgentSession[Any]) -> None:
    @session.on("conversation_item_added")
    def _on_item(ev: ConversationItemAddedEvent) -> None:
        item = ev.item
        if isinstance(item, llm.ChatMessage) and item.role == "assistant":
            latency = turn_latency(item.metrics)
            if latency:
                logger.info("agent turn", extra={"latency": latency})

    @session.on("error")
    def _on_error(ev: ErrorEvent) -> None:
        logger.warning(
            "pipeline error",
            extra={"source": type(ev.source).__name__, "error": type(ev.error).__name__},
        )

    @session.on("close")
    def _on_close(ev: CloseEvent) -> None:
        logger.info("session closed", extra={"reason": str(ev.reason)})
