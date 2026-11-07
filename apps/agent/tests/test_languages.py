from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any
from unittest.mock import MagicMock

import pytest
from livekit.agents import stt

from meet_impar_agent.languages import (
    base_language,
    clean_voices,
    guess_language,
    languages_note,
    main_language,
    pick_language,
)
from meet_impar_agent.persona import Talker, VoiceAgent
from meet_impar_agent.profile import AgentProfile

VOICES = {"pt": "voz-pt-1", "en": "voice-en-1", "es": "voz-es-1"}


def profile(**overrides: Any) -> AgentProfile:
    base: dict[str, Any] = {
        "name": "Kaiser",
        "instructions": "x",
        "greeting": "",
        "voice_id": "voz-pt-1",
        "tts_model": "s2.1-pro",
        "llm_model": "m",
    }
    return AgentProfile(**(base | overrides))


def test_voices_keep_only_known_languages_and_valid_ids() -> None:
    raw = {"es": " voz-es-1 ", "fr": "voix-1", "en": "x", "pt": "voz-pt-1"}
    assert clean_voices(raw) == {"pt": "voz-pt-1", "es": "voz-es-1"}
    assert list(clean_voices(raw)) == ["pt", "es"]
    assert clean_voices(None) == {}


def test_language_codes_are_reduced_to_the_base_language() -> None:
    assert base_language("en-US") == "en"
    assert base_language("pt_BR") == "pt"
    assert base_language("fr") is None
    assert main_language({"en": "voice-en-1"}) == "en"
    assert main_language({}) == "pt"


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Oi Kaiser, tudo bem com você?", "pt"),
        ("Kaiser, você pode me ajudar com isso?", "pt"),
        ("Não, eu quero saber a programação de amanhã.", "pt"),
        ("Hola Kaiser, ¿cómo estás?", "es"),
        ("Muchas gracias, eso es muy bueno.", "es"),
        ("Hi Kaiser, what time is the meeting?", "en"),
        ("Can you tell me about the project?", "en"),
        ("Kaiser", None),
        ("ok", None),
    ],
)
def test_the_words_tell_the_language(text: str, expected: str | None) -> None:
    assert guess_language(text) == expected


def test_fish_mistakes_do_not_switch_the_language() -> None:
    # Fish says English (its starting value) or Spanish for clearly Portuguese speech
    assert pick_language("pt", "en", "Oi, tudo bem?", VOICES) == "pt"
    assert pick_language("pt", "es", "Kaiser, você pode explicar isso de novo?", VOICES) == "pt"
    # too short to trust Fish: keep the current language
    assert pick_language("pt", "en", "Kaiser", VOICES) == "pt"
    assert pick_language("en", "pt", "okay", VOICES) == "en"
    # long phrase with no clue in the words: Fish decides
    assert pick_language("pt", "en", "Kaiser summary meeting project status", VOICES) == "en"
    # a language without a voice falls back to the main one
    spanish = "Hola, ¿cómo estás? Muy bien, gracias."
    assert pick_language("en", "es", spanish, {"pt": "a-voz"}) == "pt"
    assert pick_language("en", "fr", "Bonjour monsieur Kaiser comment allez vous", VOICES) == "pt"


def test_only_multilingual_agents_get_language_instructions() -> None:
    assert languages_note({"pt": "voz-pt-1"}) == ""
    note = languages_note(VOICES)
    assert "inglês" in note
    assert "[en]" in note


def _event(text: str, language: str) -> stt.SpeechEvent:
    return stt.SpeechEvent(
        type=stt.SpeechEventType.FINAL_TRANSCRIPT,
        alternatives=[stt.SpeechData(language=language, text=text)],
    )


def test_agent_tags_the_language_and_switches_voice() -> None:
    agent = VoiceAgent(profile(voices=VOICES), speaker=lambda: Talker(name="Ana", role="guest"))
    event = agent.label_event(_event("What time is it?", "en"))
    assert isinstance(event, stt.SpeechEvent)
    assert event.alternatives[0].text == "Ana (convidado) [en]: What time is it?"
    assert agent.language == "en"

    tts = MagicMock()
    session = MagicMock(tts=tts)
    agent._activity = MagicMock(session=session)
    type(agent).session = property(lambda self: session)  # type: ignore[method-assign]
    try:
        agent._use_voice_for_language()
        tts.update_options.assert_called_once_with(voice_id="voice-en-1")
        agent._use_voice_for_language()
        tts.update_options.assert_called_once()
    finally:
        del type(agent).session

    agent.label_event(_event("Bonjour", "fr"))
    assert agent.language == "en"
    agent.label_event(_event("Bonjour monsieur, comment allez vous aujourd'hui", "fr"))
    assert agent.language == "pt"


def test_interim_transcripts_do_not_switch_the_language() -> None:
    agent = VoiceAgent(profile(voices=VOICES))
    interim = stt.SpeechEvent(
        type=stt.SpeechEventType.INTERIM_TRANSCRIPT,
        alternatives=[stt.SpeechData(language="en", text="What time is")],
    )
    event = agent.label_event(interim)
    assert isinstance(event, stt.SpeechEvent)
    assert event.alternatives[0].text == "[pt]: What time is"
    assert agent.language == "pt"


async def _stream(*chunks: str) -> AsyncIterator[str]:
    for chunk in chunks:
        yield chunk


async def _collect(text: Any) -> str:
    return "".join([chunk async for chunk in text])


async def test_the_voice_follows_the_language_the_reply_is_written_in() -> None:
    agent = VoiceAgent(profile(voices=VOICES))
    agent.language = "es"
    reply = await agent._voice_for_reply(_stream("Claro, ", "você ", "pode ", "sim. ", "Depois"))
    assert agent.language == "pt"
    assert await _collect(reply) == "Claro, você pode sim. Depois"

    unclear = await agent._voice_for_reply(_stream("Ok!", " Kaiser"))
    assert agent.language == "pt"
    assert await _collect(unclear) == "Ok! Kaiser"

    single = VoiceAgent(profile(voices={"pt": "voz-pt-1"}))
    text = _stream("Hello there, how are you?")
    assert await single._voice_for_reply(text) is text


def test_single_language_agents_are_untouched() -> None:
    agent = VoiceAgent(
        profile(voices={"pt": "voz-pt-1"}), speaker=lambda: Talker(name="Ana", role="guest")
    )
    event = agent.label_event(_event("Oi", "pt"))
    assert isinstance(event, stt.SpeechEvent)
    assert event.alternatives[0].text == "Ana (convidado): Oi"
