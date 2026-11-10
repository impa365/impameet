"""Who the agent listens to in a group, and whether a turn was addressed to it.

LiveKit Agents transcribe one linked participant at a time. To hold a group conversation
the agent follows whoever is speaking, restricted by the room's listen mode.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass

from .profile import ListenMode


@dataclass(frozen=True)
class Speaker:
    identity: str
    role: str
    is_agent: bool


def may_listen(speaker: Speaker, mode: ListenMode) -> bool:
    if speaker.is_agent:
        return False
    if mode == "moderators":
        return speaker.role == "moderator"
    if mode == "members":
        return speaker.role in ("moderator", "participant")
    return True


def next_linked(speakers: Iterable[Speaker], current: str | None, mode: ListenMode) -> str | None:
    """Identity to link to now: keep the current one while it talks, else the loudest eligible."""
    eligible = [s.identity for s in speakers if may_listen(s, mode)]
    if not eligible or current in eligible:
        return None
    return eligible[0]


def _fold(text: str) -> str:
    folded = unicodedata.normalize("NFKD", text.lower())
    return "".join(c for c in folded if not unicodedata.combining(c))


def same_name(a: str, b: str) -> bool:
    """Names as people say them: case and accents do not matter."""
    return _fold(a).strip() == _fold(b).strip() != ""


#: Shorter words are left alone: "Ana" must be heard as "Ana".
_FUZZY_MIN_LETTERS = 4
_LONG_NAME = 6


def _distance(a: str, b: str) -> int:
    """Levenshtein distance (names are short, so the plain table is enough)."""
    row = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        prev, row[0] = row[0], i
        for j, cb in enumerate(b, 1):
            prev, row[j] = row[j], min(row[j] + 1, row[j - 1] + 1, prev + (ca != cb))
    return row[-1]


def sounds_like(word: str, name: str) -> bool:
    """A transcription slip of the name: "Kaísa", "Kaize" or "Kaizen" for "Kaiser".

    Speech-to-text often misspells unusual names. A word counts when it starts like the name
    and differs by one letter (two for names of six letters or more), so "casa" or "caixa"
    are still not "Kaiser".
    """
    if word == name:
        return True
    if min(len(word), len(name)) < _FUZZY_MIN_LETTERS or word[:2] != name[:2]:
        return False
    return _distance(word, name) <= (2 if len(name) >= _LONG_NAME else 1)


def _position(folded_text: str, agent_name: str) -> int | None:
    name = _fold(agent_name).strip()
    if not name:
        return None
    found = re.search(rf"(?<![a-z0-9]){re.escape(name)}(?![a-z0-9])", folded_text)
    if found:
        return found.start()
    if " " in name:
        return None
    for word in re.finditer(r"[a-z0-9]+", folded_text):
        if sounds_like(word.group(), name):
            return word.start()
    return None


def is_addressed(text: str, agent_name: str, others: Iterable[str] = ()) -> bool:
    """True when the agent's name appears as a word ("Kaiser, ..." / "ei kaiser").

    With other assistants in the room, the one named first is the one being spoken to:
    "Kaiser, apresente e depois passe para a Ana" is for Kaiser, not for Ana.
    """
    if not _fold(agent_name).strip():
        return True
    folded = _fold(text)
    mine = _position(folded, agent_name)
    if mine is None:
        return False
    rivals = [p for p in (_position(folded, o) for o in others) if p is not None]
    return all(mine <= p for p in rivals)
