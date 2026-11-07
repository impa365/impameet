"""Process-wide log redaction.

Installed as a ``LogRecord`` factory so it covers every logger, including third-party
libraries and handlers installed after start-up.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Iterable
from typing import Any

REDACTED = "[REDACTED]"
MIN_SECRET_LENGTH = 6

_installed_pattern: re.Pattern[str] | None = None
_original_factory = logging.getLogRecordFactory()


def build_pattern(secrets: Iterable[str]) -> re.Pattern[str] | None:
    """Regex matching any of ``secrets``; short values are ignored to avoid false hits."""
    unique = sorted({s for s in secrets if len(s) >= MIN_SECRET_LENGTH}, key=len, reverse=True)
    if not unique:
        return None
    return re.compile("|".join(re.escape(s) for s in unique))


def redact(text: str, pattern: re.Pattern[str] | None) -> str:
    return pattern.sub(REDACTED, text) if pattern else text


class _RedactingRecord(logging.LogRecord):
    def getMessage(self) -> str:  # noqa: N802 - overrides the stdlib name
        return redact(super().getMessage(), _installed_pattern)


def _factory(*args: Any, **kwargs: Any) -> logging.LogRecord:
    record = _original_factory(*args, **kwargs)
    record.__class__ = _RedactingRecord
    if record.exc_info and not record.exc_text:
        # Formatters reuse a pre-filled exc_text instead of rendering the traceback again.
        record.exc_text = logging.Formatter().formatException(record.exc_info)
    if record.exc_text:
        record.exc_text = redact(record.exc_text, _installed_pattern)
    return record


_installed_secrets: set[str] = set()


def install(secrets: Iterable[str]) -> None:
    """Redact ``secrets`` from every log message emitted by this process."""
    global _installed_pattern  # noqa: PLW0603 - one process-wide pattern by design
    _installed_secrets.clear()
    _installed_secrets.update(secrets)
    _installed_pattern = build_pattern(_installed_secrets)
    logging.setLogRecordFactory(_factory)


def extend(secrets: Iterable[str]) -> None:
    """Adds secrets learned at run time (an agent's own provider keys)."""
    global _installed_pattern  # noqa: PLW0603
    _installed_secrets.update(secrets)
    _installed_pattern = build_pattern(_installed_secrets)
    logging.setLogRecordFactory(_factory)


def uninstall() -> None:
    global _installed_pattern  # noqa: PLW0603
    _installed_secrets.clear()
    _installed_pattern = None
    logging.setLogRecordFactory(_original_factory)
