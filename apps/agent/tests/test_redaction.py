from __future__ import annotations

import logging

import pytest

from meet_impar_agent import redaction
from meet_impar_agent.redaction import REDACTED, build_pattern, redact

SECRET = "super-secret-token-123"


def test_pattern_ignores_short_and_duplicate_values() -> None:
    pattern = build_pattern(["abc", SECRET, SECRET, ""])

    assert pattern is not None
    assert redact(f"x {SECRET} abc", pattern) == f"x {REDACTED} abc"


def test_no_pattern_when_nothing_to_redact() -> None:
    assert build_pattern(["a", ""]) is None
    assert redact("unchanged", None) == "unchanged"


def test_longest_secret_wins_when_secrets_overlap() -> None:
    pattern = build_pattern(["secret-1", "secret-12345"])

    assert redact("secret-12345", pattern) == REDACTED


def test_regex_metacharacters_are_literal() -> None:
    pattern = build_pattern(["a.b*c+d?"])

    assert redact("a.b*c+d? axbbbcd", pattern) == f"{REDACTED} axbbbcd"


def test_installed_redaction_covers_messages_args_and_child_loggers(
    caplog: pytest.LogCaptureFixture,
) -> None:
    redaction.install([SECRET])
    caplog.set_level(logging.INFO)

    logging.getLogger("third.party.lib").info("connecting with %s", SECRET)
    logging.getLogger().warning(f"inline {SECRET}")

    assert SECRET not in caplog.text
    assert caplog.text.count(REDACTED) == 2


def test_installed_redaction_covers_tracebacks(caplog: pytest.LogCaptureFixture) -> None:
    redaction.install([SECRET])

    try:
        raise RuntimeError(f"bad key {SECRET}")
    except RuntimeError:
        logging.getLogger("x").exception("request failed")

    assert SECRET not in caplog.text
    assert REDACTED in caplog.text


def test_uninstall_restores_the_original_factory(caplog: pytest.LogCaptureFixture) -> None:
    redaction.install([SECRET])
    redaction.uninstall()
    caplog.set_level(logging.INFO)

    logging.getLogger("x").info(SECRET)

    assert SECRET in caplog.text
