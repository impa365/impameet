"""Answering in the speaker's language, with a Fish Audio voice for each language.

Fish detects the language of what it transcribes, but it reports English until it has heard
enough and often mistakes Portuguese for Spanish. So the words themselves decide first; Fish's
guess only counts on longer phrases that the words do not contradict. The agent replies in
that language when it has a voice for it, and otherwise in its main language.
"""

from __future__ import annotations

import re
from collections.abc import Mapping

LANGUAGES = ("pt", "en", "es")
LANGUAGE_NAMES = {"pt": "português do Brasil", "en": "inglês", "es": "espanhol"}
_VOICE = re.compile(r"^[A-Za-z0-9_-]{4,64}$")
_WORD = re.compile(r"[^\W\d_]+(?:'[^\W\d_]+)?")


# Words (and letters) found in one of the three languages but not in the other two.
def _markers(text: str) -> frozenset[str]:
    return frozenset(text.split())


_MARKERS: dict[str, frozenset[str]] = {
    "pt": _markers(
        "não você vocês é estou eu isso isto muito obrigado obrigada tudo bem então também olá "
        "oi sim uma um com do da dos das na ao pra meu minha quero queria pode posso vai agora "
        "aqui ele ela nós gente qual quem onde quando cadê beleza tá né já fala falar tchau bom "
        "boa dia noite ajuda ajudar seu sua aí"
    ),
    "es": _markers(
        "usted ustedes hola gracias pero muy bueno buenos buenas entonces yo eso esto qué cómo "
        "dónde cuándo cuál quién sí estoy es una un con del el los las la al mi también tú "
        "nosotros puede puedo quiero ahora aquí él ella ya vale señor hablar ayuda ayudar día "
        "noches tardes adiós cuando"
    ),
    "en": _markers(
        "the you is are what and how hello hi please thanks thank i i'm it's this that can "
        "could would does about yes my we they with for of to in on hey what's good morning "
        "tell help speak english bye there here"
    ),
}
_LETTERS = {"pt": "ãõç", "es": "ñ¿¡"}
_MIN_WORDS_FOR_DETECTOR = 4


def clean_voices(raw: object) -> dict[str, str]:
    """Only known languages and well-formed voice ids, in the order pt, en, es."""
    if not isinstance(raw, Mapping):
        return {}
    voices: dict[str, str] = {}
    for lang in LANGUAGES:
        voice = raw.get(lang)
        if isinstance(voice, str) and _VOICE.match(voice.strip()):
            voices[lang] = voice.strip()
    return voices


def base_language(code: str | None) -> str | None:
    """'pt-BR' / 'en_US' / 'ES' -> 'pt' / 'en' / 'es'; anything else -> None."""
    if not code:
        return None
    base = code.strip().lower().replace("_", "-").split("-")[0]
    return base if base in LANGUAGES else None


def main_language(voices: Mapping[str, str]) -> str:
    return next(iter(voices), "pt")


def words(text: str) -> list[str]:
    return _WORD.findall(text.lower())


def language_scores(text: str) -> dict[str, int]:
    tokens = words(text)
    lowered = text.lower()
    scores = {}
    for lang, markers in _MARKERS.items():
        letters = _LETTERS.get(lang, "")
        scores[lang] = sum(t in markers for t in tokens) + 2 * sum(c in letters for c in lowered)
    return scores


def guess_language(text: str) -> str | None:
    """The language the words clearly belong to, or None when they do not tell."""
    scores = language_scores(text)
    best, second = sorted(scores.values(), reverse=True)[:2]
    if best < 2 or best < 2 * second:  # noqa: PLR2004
        return None
    return max(scores, key=scores.__getitem__)


def pick_language(current: str, detected: str | None, text: str, voices: Mapping[str, str]) -> str:
    """The language to answer this phrase in."""
    main = main_language(voices)
    guess = guess_language(text)
    if guess is not None:
        return guess if guess in voices else main
    if len(words(text)) < _MIN_WORDS_FOR_DETECTOR:
        return current
    lang = base_language(detected)
    if lang is None:
        return main if detected else current
    scores = language_scores(text)
    if any(score > scores[lang] for score in scores.values()):
        return current
    return lang if lang in voices else main


def languages_note(voices: Mapping[str, str]) -> str:
    """Instructions for an agent that speaks more than one language."""
    if len(voices) < 2:  # noqa: PLR2004
        return ""
    names = ", ".join(LANGUAGE_NAMES[lang] for lang in voices)
    main = LANGUAGE_NAMES[main_language(voices)]
    return (
        f"IDIOMAS: você fala {names}. Cada fala chega marcada com o idioma em que você deve "
        "responder, como [pt], [en] ou [es]. Responda sempre e somente no idioma da marca da "
        "última fala, com a resposta inteira nesse idioma, sem misturar idiomas. Essa regra "
        "vale mais do que qualquer outra instrução sobre idioma (inclusive 'fale sempre em "
        f"português'). Se a pessoa falar um idioma fora dessa lista, responda em {main}."
    )
