"""Skips the real-browser tests when Playwright's Chromium is not installed."""

from __future__ import annotations

import os
import shutil
from pathlib import Path

import pytest

# Playwright's browser folders: PLAYWRIGHT_BROWSERS_PATH, Linux, macOS, Windows, the image.
_BROWSER_DIRS = [
    Path(os.environ.get("PLAYWRIGHT_BROWSERS_PATH") or "/nonexistent"),
    Path.home() / ".cache/ms-playwright",
    Path.home() / "Library/Caches/ms-playwright",
    Path(os.environ.get("LOCALAPPDATA") or "/nonexistent") / "ms-playwright",
    Path("/opt/ms-playwright"),
]


def chromium_installed() -> bool:
    return bool(shutil.which("chromium")) or any(any(d.glob("chromium*")) for d in _BROWSER_DIRS)


chromium = pytest.mark.skipif(
    not chromium_installed(), reason="Playwright Chromium is not installed"
)
