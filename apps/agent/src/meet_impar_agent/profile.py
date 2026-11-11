"""Which agent a room asked for, and how it should behave.

Rooms on the IMPA Meet platform pick a configured agent; the dispatch metadata carries its
id and the worker fetches the configuration from the platform's internal API. Without a
platform, or when the lookup fails or a choice is missing, the agent stays out of the meeting.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any, Literal

import aiohttp

from . import redaction
from .config import Settings
from .insights import clean_access, clean_insights
from .knowledge import clean_examples
from .languages import clean_voices
from .providers import SpeechProvider, speech_provider

logger = logging.getLogger("meet_impar_agent.profile")

ListenMode = Literal["everyone", "moderators", "members"]
RespondMode = Literal["always", "when_named"]
# Who may tell the agent to stop talking (and to talk again); "disabled" turns the feature off.
MutePolicy = Literal["everyone", "moderators", "disabled"]
MUTE_POLICIES = ("everyone", "moderators", "disabled")
TtsLatency = Literal["low", "balanced", "normal"]
TTS_LATENCIES = ("low", "balanced", "normal")

KNOWLEDGE_HEADER = (
    "\n\nBASE DE CONHECIMENTO (use estas informações para responder; se a resposta não estiver "
    "aqui nem for conhecimento geral seguro, diga que não sabe):\n"
)
LOOKUP_TIMEOUT_S = 5.0
MODERATION_TOOLS = ("remove", "mute", "lobby", "camera", "record")
MAX_RULES_CHARS = 4000
PERCEPTION = ("board", "polls", "screen")
MAX_AGENT_ID_LENGTH = 64


@dataclass(frozen=True)
class AgentProfile:
    name: str
    instructions: str
    greeting: str
    voice_id: str | None
    tts_model: str
    llm_model: str
    # How it thinks and sounds, chosen in the agent like its providers (nothing is preset).
    llm_temperature: float
    llm_max_tokens: int
    llm_timeout_s: float
    thinking_volume: float
    # Fish Audio only: its trade-off between how soon the voice starts and how it sounds.
    tts_latency: TtsLatency | None
    listen_mode: ListenMode = "everyone"
    respond_mode: RespondMode = "always"
    mute_policy: MutePolicy = "everyone"
    # The agent's own provider credentials (Integrações).
    llm_base_url: str | None = field(default=None, repr=False)
    llm_api_key: str | None = field(default=None, repr=False)
    # Speaking and listening are chosen separately: any provider for each.
    tts_provider: SpeechProvider = "fish"
    tts_api_key: str | None = field(default=None, repr=False)
    stt_provider: SpeechProvider = "fish"
    stt_api_key: str | None = field(default=None, repr=False)
    stt_model: str = ""
    # The TTS provider's voice per language ("pt", "en", "es").
    voices: dict[str, str] = field(default_factory=dict)
    agent_id: str = ""
    # What it may do to other people (off unless an admin turned it on) and the admin's rules.
    moderation_tools: tuple[str, ...] = ()
    moderation_rules: str = ""
    # What in the meeting it may look at when asked (off unless an admin turned it on).
    perception: tuple[str, ...] = ()
    # Minutes, "what did I miss?", copilot, metrics; and who sees the copilot and the metrics.
    insights: tuple[str, ...] = ()
    insights_access: str = "moderators"
    # Training (style rules, approved answers) and how many knowledge bases it can search.
    style_rules: str = ""
    examples: tuple[tuple[str, str], ...] = ()
    knowledge_bases: int = 0

    def secrets(self) -> list[str]:
        return [s for s in (self.llm_api_key, self.tts_api_key, self.stt_api_key) if s]


def _metadata(metadata: str | None) -> dict[str, Any]:
    if not metadata or not isinstance(metadata, str):
        return {}
    try:
        data = json.loads(metadata)
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def agent_id_from_metadata(metadata: str | None) -> str | None:
    """The configured agent id in the dispatch metadata, if any."""
    agent_id = _metadata(metadata).get("agentId")
    valid = isinstance(agent_id, str) and 0 < len(agent_id) <= MAX_AGENT_ID_LENGTH
    return agent_id if valid else None


def agent_actions(metadata: str | None) -> bool:
    """The room's switch for the AI acting and observing (on unless moderators turned it off)."""
    return _metadata(metadata).get("agentActions") is not False


def board_policy(metadata: str | None) -> str:
    """Who may draw on the whiteboard; drawings from anyone else are ignored."""
    return "moderators" if _metadata(metadata).get("boardPolicy") == "moderators" else "everyone"


def thinking_sound(metadata: str | None) -> bool:
    """The room's typing-sound switch, sent with the dispatch (on unless the room turned it off)."""
    return _metadata(metadata).get("thinkingSound") is not False


def job_mode(metadata: str | None) -> Literal["voice", "captions"]:
    """The platform dispatches the same worker either as the voice agent or as live captions."""
    return "captions" if _metadata(metadata).get("mode") == "captions" else "voice"


MAX_DISPLAY_NAME_LENGTH = 60
DEFAULT_DISPLAY_NAME = "Assistente de IA"
CAPTIONS_DISPLAY_NAME = "Legendas"


MAX_ABOUT_LENGTH = 160


def _clean(text: str) -> str:
    return " ".join("".join(ch for ch in text if ch.isprintable()).split())


def agent_about(metadata: str | None) -> str:
    """What the agent is for (optional), shown next to its name in the room."""
    about = _metadata(metadata).get("agentDescription")
    return _clean(about)[:MAX_ABOUT_LENGTH] if isinstance(about, str) else ""


def join_attributes(metadata: str | None) -> dict[str, str]:
    """Attributes the agent joins with: its mode, which agent it is and what it does."""
    attributes: dict[str, str] = {"impa.mode": job_mode(metadata)}
    if agent_id := agent_id_from_metadata(metadata):
        attributes["impa.agent"] = agent_id
    if about := agent_about(metadata):
        attributes["impa.about"] = about
    return attributes


def display_name(metadata: str | None) -> str:
    """The name people see on the agent's tile, sent by the platform with the dispatch."""
    if job_mode(metadata) == "captions":
        return CAPTIONS_DISPLAY_NAME
    name = _metadata(metadata).get("agentName")
    if not isinstance(name, str):
        return DEFAULT_DISPLAY_NAME
    return _clean(name)[:MAX_DISPLAY_NAME_LENGTH] or DEFAULT_DISPLAY_NAME


def profile_from_platform(remote: dict[str, Any]) -> AgentProfile | None:
    """The agent exactly as configured on the platform, or None when a choice is missing.

    Nothing falls back to this worker's own provider, model or voice: an agent without its
    LLM integration and model, its speech (TTS) and transcription (STT) integrations, voices
    and models does not join a meeting.
    """
    llm = _section(remote, "llm")
    speech = _section(remote, "tts")
    listening = _section(remote, "stt")
    tts_provider = speech_provider(speech.get("provider"))
    stt_provider = speech_provider(listening.get("provider"))
    voices = clean_voices(remote.get("voices"))
    required = {
        "name": _text(remote.get("name")),
        "instructions": _text(remote.get("instructions")),
        "llm_base_url": _text(llm.get("baseUrl")),
        "llm_api_key": _text(llm.get("apiKey")),
        "llm_model": _text(remote.get("llmModel")),
        "tts_api_key": _text(speech.get("apiKey")),
        "stt_api_key": _text(listening.get("apiKey")),
        "tts_model": _text(remote.get("ttsModel")),
        "stt_model": _text(remote.get("sttModel")),
    }
    tuning = {
        "llm_temperature": _number(remote.get("llmTemperature"), 0, 2),
        "llm_max_tokens": _number(remote.get("llmMaxTokens"), 16, 8192),
        "llm_timeout_s": _number(remote.get("llmTimeoutS"), 1, 120),
        "thinking_volume": _number(remote.get("thinkingVolume"), 0, 1),
    }
    latency = remote.get("ttsLatency")
    tts_latency: TtsLatency | None = latency if latency in TTS_LATENCIES else None
    missing = [key for key, value in [*required.items(), *tuning.items()] if value is None]
    if not voices:
        missing.append("voices")
    if tts_provider is None:
        missing.append("tts_provider")
    if stt_provider is None:
        missing.append("stt_provider")
    if tts_provider == "fish" and tts_latency is None:
        missing.append("tts_latency")
    if missing or tts_provider is None or stt_provider is None:
        logger.error("agent is not fully configured", extra={"missing": missing})
        return None
    instructions = str(required["instructions"])
    knowledge = str(remote.get("knowledge") or "").strip()
    if knowledge:
        instructions = f"{instructions}{KNOWLEDGE_HEADER}{knowledge}"
    listen = remote.get("listenMode")
    respond = remote.get("respondMode")
    mute = remote.get("mutePolicy")
    return AgentProfile(
        name=str(required["name"]),
        instructions=instructions,
        greeting=str(remote.get("greeting") or ""),
        voice_id=next(iter(voices.values())),
        tts_model=str(required["tts_model"]),
        stt_model=str(required["stt_model"]),
        llm_model=str(required["llm_model"]),
        llm_temperature=float(tuning["llm_temperature"] or 0),
        llm_max_tokens=int(tuning["llm_max_tokens"] or 0),
        llm_timeout_s=float(tuning["llm_timeout_s"] or 0),
        thinking_volume=float(tuning["thinking_volume"] or 0),
        tts_latency=tts_latency if tts_provider == "fish" else None,
        listen_mode=listen if listen in ("everyone", "moderators", "members") else "everyone",
        respond_mode=respond if respond in ("always", "when_named") else "always",
        mute_policy=mute if mute in MUTE_POLICIES else "everyone",
        llm_base_url=required["llm_base_url"],
        llm_api_key=required["llm_api_key"],
        tts_provider=tts_provider,
        tts_api_key=required["tts_api_key"],
        stt_provider=stt_provider,
        stt_api_key=required["stt_api_key"],
        voices=voices,
        agent_id=str(remote.get("id") or ""),
        moderation_tools=clean_tools(remote.get("moderationTools")),
        moderation_rules=clean_rules(remote.get("moderationRules")),
        perception=clean_perception(remote.get("perception")),
        insights=clean_insights(remote.get("insights")),
        insights_access=clean_access(remote.get("insightsAccess")),
        style_rules=str(remote.get("styleRules") or "")[:2000],
        examples=clean_examples(remote.get("examples")),
        knowledge_bases=_count(remote.get("knowledgeBases")),
    )


def clean_tools(raw: object) -> tuple[str, ...]:
    """The moderation tools an admin turned on, in a fixed order; anything else is dropped."""
    if not isinstance(raw, list):
        return ()
    return tuple(t for t in MODERATION_TOOLS if t in raw)


def clean_perception(raw: object) -> tuple[str, ...]:
    """What an admin let the agent look at, in a fixed order; anything else is dropped."""
    if not isinstance(raw, list):
        return ()
    return tuple(p for p in PERCEPTION if p in raw)


def _count(raw: object) -> int:
    return raw if isinstance(raw, int) and not isinstance(raw, bool) and raw > 0 else 0


def clean_rules(raw: object) -> str:
    return raw.strip()[:MAX_RULES_CHARS] if isinstance(raw, str) else ""


def _section(remote: dict[str, Any], key: str) -> dict[str, Any]:
    value = remote.get(key)
    return value if isinstance(value, dict) else {}


def _number(value: object, low: float, high: float) -> float | None:
    """A number the platform sent within its range, or None (then the agent stays out)."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value) if low <= value <= high else None


def _text(value: object) -> str | None:
    return value.strip() or None if isinstance(value, str) else None


async def load_profile(settings: Settings, metadata: str | None) -> AgentProfile | None:
    """The room's agent from the platform; None (and the agent stays out) if it cannot be used."""
    agent_id = agent_id_from_metadata(metadata)
    platform = settings.platform
    if not agent_id or platform is None:
        logger.error("no configured agent to load", extra={"has_platform": platform is not None})
        return None
    url = f"{str(platform.url).rstrip('/')}/api/internal/agents/{agent_id}"
    headers = {"x-internal-token": platform.token.get_secret_value()}
    try:
        timeout = aiohttp.ClientTimeout(total=LOOKUP_TIMEOUT_S)
        async with (
            aiohttp.ClientSession(timeout=timeout) as http,
            http.get(url, headers=headers) as res,
        ):
            if res.status != 200:  # noqa: PLR2004
                logger.warning("agent lookup failed", extra={"status": res.status})
                return None
            body = await res.json()
    except (aiohttp.ClientError, TimeoutError, ValueError) as exc:
        logger.warning("agent lookup failed", extra={"error": type(exc).__name__})
        return None
    remote = body.get("agent") if isinstance(body, dict) else None
    if not isinstance(remote, dict):
        return None
    profile = profile_from_platform(remote)
    if profile is not None:
        redaction.extend(profile.secrets())
    return profile
