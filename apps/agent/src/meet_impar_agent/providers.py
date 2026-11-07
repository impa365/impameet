"""Speech providers an agent can use, chosen separately for listening (STT) and speaking (TTS).

Any combination works, e.g. Deepgram transcribing and ElevenLabs speaking. Each provider has
its own account (API key), models and voices, all chosen per agent on the platform.
"""

from __future__ import annotations

from typing import Any, Literal

SpeechProvider = Literal["fish", "deepgram", "elevenlabs"]
SPEECH_PROVIDERS: tuple[SpeechProvider, ...] = ("fish", "deepgram", "elevenlabs")

# Deepgram TTS families: Flux TTS on /v2/speak and Aura-2 on /v1/speak. Their voices are full
# model names ("flux-bianca-pt", "aura-2-celeste-es"), one per language.
DEEPGRAM_TTS_FAMILIES = ("flux", "aura-2")
# Flux conversational STT (/v2/listen): end of turn decided by the model itself.
DEEPGRAM_MULTILINGUAL_STT = "flux-general-multi"


def speech_provider(value: object) -> SpeechProvider | None:
    for provider in SPEECH_PROVIDERS:
        if value == provider:
            return provider
    return None


def voice_options(provider: SpeechProvider, voice: str, language: str) -> dict[str, Any]:
    """`tts.update_options(...)` arguments that switch to another language's voice."""
    if provider == "deepgram":
        return {"model": voice}
    if provider == "elevenlabs":
        return {"voice_id": voice, "language": language}
    return {"voice_id": voice}
