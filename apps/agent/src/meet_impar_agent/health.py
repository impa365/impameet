"""Publishes why the agent stayed quiet or failed — LiveKit attrs + platform events.

No transcripts or secrets: only short codes the admin can read.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import httpx
from livekit import rtc

from .config import PlatformSettings

logger = logging.getLogger("meet_impar_agent.health")

HEALTH_ATTRIBUTE = "impa.health"
SKIP_ATTRIBUTE = "impa.skip"
ERR_ATTRIBUTE = "impa.err"

# LiveKit attribute values (short, stable).
HEALTH_OK = "ok"
HEALTH_SILENT = "silent"
HEALTH_ERROR = "error"

SKIP_MUTED = "muted"
SKIP_NOT_ADDRESSED = "not_addressed"
SKIP_PEERS = "peers"
SKIP_LISTEN = "listen_mode"

ERR_STT = "stt"
ERR_LLM = "llm"
ERR_TTS = "tts"
ERR_OTHER = "other"

TIMEOUT_S = 8.0
SKIP_THROTTLE_S = 8.0
ERROR_THROTTLE_S = 5.0


def classify_pipeline_source(source_name: str, error_name: str) -> str:
    blob = f"{source_name} {error_name}".lower()
    # TTS before STT: names like "ElevenLabsTTS" contain the letters "stt".
    if "tts" in blob or "synth" in blob or "eleven" in blob or "fishaudio" in blob:
        return ERR_TTS
    if "stt" in blob or "transcri" in blob or "recogn" in blob or "deepgram" in blob:
        return ERR_STT
    if "llm" in blob or "openai" in blob or "chat" in blob or "complet" in blob:
        return ERR_LLM
    return ERR_OTHER


class HealthReporter:
    """Tracks the current reason the agent is quiet or broken for admins and the room UI."""

    def __init__(
        self,
        *,
        platform: PlatformSettings | None,
        agent_id: str | None,
        room_name: str,
        participant: rtc.LocalParticipant | None = None,
        session_id: str | None = None,
    ) -> None:
        self._platform = platform
        self._agent_id = agent_id
        self._room_name = room_name
        self._participant = participant
        self._session_id = session_id
        self._health = HEALTH_OK
        self._skip = ""
        self._err = ""
        self._last_skip_at = 0.0
        self._last_skip_code = ""
        self._last_err_at = 0.0
        self._last_err_code = ""
        self._tasks: set[asyncio.Task[Any]] = set()

    def bind(self, participant: rtc.LocalParticipant, session_id: str | None = None) -> None:
        self._participant = participant
        if session_id:
            self._session_id = session_id

    def _spawn(self, coro: Any) -> None:
        task = asyncio.ensure_future(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _set_attrs(self) -> None:
        if self._participant is None:
            return
        try:
            await self._participant.set_attributes(
                {
                    HEALTH_ATTRIBUTE: self._health,
                    SKIP_ATTRIBUTE: self._skip,
                    ERR_ATTRIBUTE: self._err,
                }
            )
        except Exception:
            logger.debug("could not publish health attributes", exc_info=True)

    async def _post(
        self,
        kind: str,
        code: str,
        *,
        source: str | None = None,
        detail: str | None = None,
    ) -> None:
        if not self._platform or not self._agent_id:
            return
        url = f"{str(self._platform.url).rstrip('/')}/api/internal/agents/{self._agent_id}/events"
        body: dict[str, Any] = {
            "room": self._room_name,
            "kind": kind,
            "code": code,
        }
        if self._session_id:
            body["sessionId"] = self._session_id
        if source:
            body["source"] = source
        if detail:
            body["detail"] = detail[:200]
        try:
            async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
                await client.post(
                    url,
                    json=body,
                    headers={"x-internal-token": self._platform.token.get_secret_value()},
                )
        except httpx.HTTPError as exc:
            logger.warning("could not send health event", extra={"error": type(exc).__name__})

    def joined(self) -> None:
        self._health, self._skip, self._err = HEALTH_OK, "", ""
        self._spawn(self._set_attrs())
        self._spawn(self._post("joined", "ok"))

    def left(self, reason: str = "closed") -> None:
        self._spawn(self._post("left", reason[:40]))

    def rejected(self, code: str = "config_missing") -> None:
        self._spawn(self._post("rejected", code))

    def answered(self) -> None:
        if self._health == HEALTH_OK and not self._skip and not self._err:
            return
        self._health, self._skip, self._err = HEALTH_OK, "", ""
        self._spawn(self._set_attrs())
        self._spawn(self._post("answered", "ok"))

    def skip(self, code: str) -> None:
        now = time.monotonic()
        if code == self._last_skip_code and now - self._last_skip_at < SKIP_THROTTLE_S:
            return
        self._last_skip_at, self._last_skip_code = now, code
        self._health, self._skip, self._err = HEALTH_SILENT, code, ""
        kind = "muted" if code == SKIP_MUTED else "skipped_reply"
        self._spawn(self._set_attrs())
        self._spawn(self._post(kind, code))

    def unmuted(self) -> None:
        self._health, self._skip, self._err = HEALTH_OK, "", self._err
        self._spawn(self._set_attrs())
        self._spawn(self._post("unmuted", "ok"))

    def pipeline_error(self, source_name: str, error_name: str) -> None:
        code = classify_pipeline_source(source_name, error_name)
        now = time.monotonic()
        if code == self._last_err_code and now - self._last_err_at < ERROR_THROTTLE_S:
            return
        self._last_err_at, self._last_err_code = now, code
        self._health, self._err, self._skip = HEALTH_ERROR, code, ""
        detail = f"{source_name}:{error_name}"[:200]
        self._spawn(self._set_attrs())
        self._spawn(self._post("pipeline_error", code, source=code, detail=detail))
