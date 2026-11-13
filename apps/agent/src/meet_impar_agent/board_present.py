"""Topics the agent presents on the meeting's own whiteboard, as native Excalidraw text.

Unlike a screen share (pixels), text on the board reaches everyone the same way: the browsers'
text view of the board reads it (screen readers, keyboard, touch), and it says who wrote it.
The agent only ever writes elements of its own ("ai-" ids, marked as the agent's): replacing a
presentation deletes the previous one of this agent and nothing anybody else drew.
"""

from __future__ import annotations

import secrets
import textwrap
import time
from typing import Any

PREFIX = "ai-"
MAX_TOPICS = 8
MAX_TITLE = 120
MAX_TOPIC = 240
WRAP = 56
TITLE_SIZE = 36
TOPIC_SIZE = 24
LINE_HEIGHT = 1.25
GAP = 120
# Excalidraw's fractional indices: base 62, "a0" is the first integer key.
DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"


def is_own(element: dict[str, Any]) -> bool:
    custom = element.get("customData")
    return (
        str(element.get("id", "")).startswith(PREFIX)
        and isinstance(custom, dict)
        and (custom.get("agent") is True)
    )


def _number(value: object) -> float:
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else 0.0


def _indices(after: str | None, count: int) -> list[str]:
    """`count` increasing order keys after `after` (the board's last), valid fractional indices."""
    if not after:
        return [f"a{DIGITS[i]}" for i in range(count)]
    return [after + DIGITS[i + 1] for i in range(count)]


def _nonce() -> int:
    return secrets.randbelow(2**31 - 1) + 1


def _text(
    eid: str, text: str, *, x: float, y: float, size: int, index: str, mark: dict[str, Any]
) -> dict[str, Any]:
    lines = text.split("\n")
    return {
        "id": eid,
        "type": "text",
        "x": x,
        "y": y,
        "width": max(len(line) for line in lines) * size * 0.55,
        "height": len(lines) * size * LINE_HEIGHT,
        "angle": 0,
        "strokeColor": "#1e1e1e",
        "backgroundColor": "transparent",
        "fillStyle": "solid",
        "strokeWidth": 2,
        "strokeStyle": "solid",
        "roughness": 1,
        "opacity": 100,
        "groupIds": [f"{PREFIX}{mark['presentation']}"],
        "frameId": None,
        "index": index,
        "roundness": None,
        "seed": _nonce(),
        "version": 1,
        "versionNonce": _nonce(),
        "isDeleted": False,
        "boundElements": None,
        "updated": int(time.time() * 1000),
        "link": None,
        "locked": False,
        "customData": dict(mark),
        "text": text,
        "fontSize": size,
        "fontFamily": 5,
        "textAlign": "left",
        "verticalAlign": "top",
        "containerId": None,
        "originalText": text,
        "autoResize": True,
        "lineHeight": LINE_HEIGHT,
    }


def clean(title: str, topics: list[str]) -> tuple[str, list[str]]:
    """The title and up to eight topics, trimmed; empty topics are left out."""
    kept = [" ".join(t.split())[:MAX_TOPIC] for t in topics if isinstance(t, str) and t.strip()]
    return " ".join(title.split())[:MAX_TITLE], kept[:MAX_TOPICS]


def retire(board: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """This agent's presentation elements still on the board, marked as deleted (a new version)."""
    return [
        {**e, "isDeleted": True, "version": int(e.get("version", 1)) + 1, "versionNonce": _nonce()}
        for e in board
        if is_own(e) and not e.get("isDeleted")
    ]


def presentation(
    title: str, topics: list[str], board: list[dict[str, Any]], author: str
) -> list[dict[str, Any]]:
    """The elements to send: the previous presentation removed, the new one to the right of what
    is drawn (so nothing anybody drew is covered), title first and topics in reading order."""
    title, topics = clean(title, topics)
    others = [e for e in board if not e.get("isDeleted") and not is_own(e)]
    x = max((_number(e.get("x")) + _number(e.get("width")) for e in others), default=-GAP) + GAP
    y = min((_number(e.get("y")) for e in others), default=0.0)
    last = max((str(e["index"]) for e in board if isinstance(e.get("index"), str)), default=None)
    keys = _indices(last, 1 + len(topics))
    key = secrets.token_hex(4)
    mark = {"agent": True, "presentation": key, "author": author}
    elements = [
        _text(f"{PREFIX}{key}-0", title, x=x, y=y, size=TITLE_SIZE, index=keys[0], mark=mark)
    ]
    y += TITLE_SIZE * LINE_HEIGHT * 2
    for n, topic in enumerate(topics, start=1):
        wrapped = "\n".join(textwrap.wrap(f"• {topic}", WRAP, subsequent_indent="  "))
        element = _text(
            f"{PREFIX}{key}-{n}", wrapped, x=x, y=y, size=TOPIC_SIZE, index=keys[n], mark=mark
        )
        elements.append(element)
        y += element["height"] + TOPIC_SIZE * 0.6
    return retire(board) + elements


def outline(title: str, topics: list[str]) -> str:
    """The same presentation as plain text (chat, transcripts, anyone who cannot see it)."""
    title, topics = clean(title, topics)
    return "\n".join([title, *(f"• {t}" for t in topics)])
