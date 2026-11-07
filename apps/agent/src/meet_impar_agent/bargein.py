"""When someone talking over the agent should make it stop.

Plain voice activity no longer cuts the agent off: a laugh, a cough, background noise or a
quick "uhum" would otherwise silence it mid-sentence. The agent keeps talking and the STT keeps
listening. It stops only on a *finished* utterance (the STT's final transcript, which every
provider here emits at the end of a turn) that is both:

1. complete: a real sentence of at least three words, most of them not fillers, or a short
   direct command ("espera", "para") or the agent's own name; and
2. from someone taking part: a person who talked with the agent in the last few minutes, a
   moderator, or anyone who addresses the agent by name. Someone in the background who
   unmuted by accident does not qualify.

Everything else is still transcribed and kept in the conversation; it is just not allowed to
cut the agent off, and it gets an answer, if any, after the agent finishes speaking.
"""

from __future__ import annotations

import re
import time
from collections.abc import Callable, Iterable

from .listening import is_addressed

MIN_SENTENCE_WORDS = 3
MIN_MEANINGFUL_WORDS = 2
ENGAGED_WINDOW_S = 300.0

_WORD = re.compile(r"[^\W\d_]+(?:'[^\W\d_]+)?")

# Sounds and backchannels that carry no request: "hm", "uhum", "ok", laughter...
FILLERS = frozenset(
    [
        "a",
        "ah",
        "aham",
        "ahn",
        "ai",
        "e",
        "é",
        "eh",
        "ei",
        "er",
        "hã",
        "hum",
        "hm",
        "hmm",
        "hum",
        "huh",
        "né",
        "oh",
        "ok",
        "okay",
        "opa",
        "ow",
        "tá",
        "ta",
        "ué",
        "uh",
        "uhm",
        "uhum",
        "um",
        "umm",
        "ah-hã",
        "rs",
        "rsrs",
        "kk",
        "kkk",
        "kkkk",
        "haha",
        "hahaha",
        "hehe",
        "risos",
        "yeah",
        "yep",
        "yes",
        "no",
        "si",
        "sí",
        "sim",
        "não",
        "nao",
        "bom",
        "bem",
        "então",
        "entao",
        "tipo",
        "assim",
        "mm",
        "mhm",
        "uh-huh",
        "well",
        "so",
        "like",
        "right",
    ]
)

# Short commands that are complete on their own: they mean "stop talking".
STOP_WORDS = frozenset(
    [
        "para",
        "pare",
        "parar",
        "espera",
        "espere",
        "esperar",
        "peraí",
        "perai",
        "calma",
        "chega",
        "silêncio",
        "silencio",
        "pausa",
        "stop",
        "wait",
        "hold",
        "pause",
        "enough",
        "espérate",
        "detente",
        "basta",
        "alto",
    ]
)


def words(text: str) -> list[str]:
    return _WORD.findall(text.lower())


def is_complete(text: str, agent_name: str) -> bool:
    """A finished sentence or a direct command, not a fragment or a noise."""
    tokens = words(text)
    if not tokens:
        return False
    if any(t in STOP_WORDS for t in tokens) and len(tokens) <= MIN_SENTENCE_WORDS:
        return True
    if agent_name and is_addressed(text, agent_name) and len(tokens) >= MIN_MEANINGFUL_WORDS:
        return True
    meaningful = [t for t in tokens if t not in FILLERS]
    return len(tokens) >= MIN_SENTENCE_WORDS and len(meaningful) >= MIN_MEANINGFUL_WORDS


class Engagement:
    """Who has been talking with the agent recently (identity -> last answered turn)."""

    def __init__(
        self,
        window_s: float = ENGAGED_WINDOW_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._window_s = window_s
        self._clock = clock
        self._last: dict[str, float] = {}

    def touch(self, identity: str) -> None:
        if identity:
            self._last[identity] = self._clock()

    def engaged(self, identity: str) -> bool:
        seen = self._last.get(identity)
        return seen is not None and self._clock() - seen <= self._window_s


def should_interrupt(
    text: str,
    *,
    identity: str,
    role: str,
    agent_name: str,
    engagement: Engagement,
    peers: Iterable[str] = (),
) -> bool:
    """True when this finished utterance should make the agent stop talking."""
    if not identity or not is_complete(text, agent_name):
        return False
    if agent_name and is_addressed(text, agent_name, peers):
        return True
    return role == "moderator" or engagement.engaged(identity)
