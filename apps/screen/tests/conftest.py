from __future__ import annotations

import os
import sys

import pytest

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
