"""The agent as seen by the room: who is talking, when to stay quiet, what it sees."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncIterable, AsyncIterator, Awaitable, Callable, Iterable
from dataclasses import dataclass, replace
from typing import Any

from livekit import rtc
from livekit.agents import Agent, ModelSettings, StopResponse, llm, stt

from .bargein import Engagement, should_interrupt
from .languages import guess_language, languages_note, main_language, pick_language, words
from .listening import is_addressed
from .moderation import KNOCK_PROMPT, Heard, ModerationClient, moderation_note, moderation_tools
from .profile import AgentProfile, MutePolicy
from .providers import voice_options
from .screen import SCREEN_INSTRUCTIONS, ScreenClient, Snapshot, screen_tools

logger = logging.getLogger("meet_impar_agent.persona")

ROLE_LABELS = {"moderator": "moderador", "guest": "convidado", "participant": "participante"}
SPEAKER_INSTRUCTIONS = (
    "Várias pessoas podem falar com você. Cada fala chega no formato 'Nome (papel): texto'. "
    "Saiba sempre quem disse o quê, chame as pessoas pelo nome quando fizer sentido e nunca "
    "trate falas de pessoas diferentes como se fossem de uma só. "
    "Não repita esse prefixo nas suas respostas."
)
_MUTE_HOW = (
    "Se pedirem para você ficar quieto, em silêncio ou se mutar, chame silenciar_voz. Em "
    "silêncio você continua ouvindo; quando pedirem para você voltar a falar ou ligar o "
    "microfone, chame ativar_voz."
)
MUTE_INSTRUCTIONS: dict[MutePolicy, str] = {
    "everyone": _MUTE_HOW + " Qualquer pessoa pode pedir isso.",
    "moderators": _MUTE_HOW
    + " Só moderadores podem pedir isso (o papel aparece entre parênteses); se outra pessoa "
    "pedir, explique com educação que só um moderador pode.",
    "disabled": "",
}
MUTED_NOTE = (
    "\n\nAGORA VOCÊ ESTÁ EM SILÊNCIO: não responda nada. Só chame ativar_voz se pedirem "
    "para você voltar a falar."
)
PEERS_NOTE = (
    "\n\nHÁ OUTROS ASSISTENTES DE IA NESTA REUNIÃO: {peers}. Cada um cuida da sua parte. "
    "Só responda quando chamarem o seu nome ou quando outro assistente passar a vez para você. "
    "Quando terminar a sua parte e for a vez de outro assistente (porque pediram ou porque "
    "combinaram uma ordem), chame passar_a_vez com o nome dele e o que ele deve fazer."
)
HANDOFF_PROMPT = (
    "{giver} passou a vez para você e pediu: {request}. Faça isso agora, falando para a "
    "reunião, de forma curta e clara."
)
_REPLY_PEEK_WORDS = 6
_TEXT_EVENTS = (
    stt.SpeechEventType.INTERIM_TRANSCRIPT,
    stt.SpeechEventType.PREFLIGHT_TRANSCRIPT,
    stt.SpeechEventType.FINAL_TRANSCRIPT,
)


@dataclass(frozen=True)
class Talker:
    name: str
    role: str
    identity: str = ""

    def label(self) -> str:
        return f"{self.name} ({ROLE_LABELS.get(self.role, 'participante')})"


SpeakerLookup = Callable[[], Talker | None]
MuteListener = Callable[[bool], Awaitable[None]]
#: Hands the floor to another assistant by name; returns what to tell the model.
Handoff = Callable[[str, str], Awaitable[str]]


def _nobody() -> Talker | None:
    return None


class VoiceAgent(Agent):
    def __init__(
        self,
        profile: AgentProfile,
        *,
        speaker: SpeakerLookup = _nobody,
        on_mute: MuteListener | None = None,
        screen: ScreenClient | None = None,
        handoff: Handoff | None = None,
        moderation: ModerationClient | None = None,
    ) -> None:
        self._profile = profile
        self._speaker = speaker
        self._on_mute = on_mute
        self._handoff = handoff
        self._view_id: str | None = None
        self.muted = False
        self.peers: tuple[str, ...] = ()
        self._voices = dict(profile.voices)
        self._main_language = main_language(self._voices)
        self.language = self._main_language
        self._current_voice: str | None = self._voices.get(self._main_language)
        self._engagement = Engagement()
        self._heard: Heard | None = None

        tools: list[Any] = []
        if handoff is not None:
            tools += self._handoff_tools()
        parts = [profile.instructions, SPEAKER_INSTRUCTIONS, languages_note(profile.voices)]
        if screen is not None:
            tools += screen_tools(screen, self)
            parts.append(SCREEN_INSTRUCTIONS)
        if profile.mute_policy != "disabled":
            tools += self._mute_tools()
            parts.append(MUTE_INSTRUCTIONS[profile.mute_policy])
        self._moderates_lobby = moderation is not None and "lobby" in profile.moderation_tools
        if moderation is not None and profile.moderation_tools:
            tools += moderation_tools(
                moderation,
                self,
                profile.moderation_tools,
                has_rules=bool(profile.moderation_rules),
            )
            parts.append(moderation_note(profile.moderation_tools, profile.moderation_rules))
        self._base_instructions = "\n\n".join(p for p in parts if p)
        # Voice activity alone never cuts the agent off; see `_maybe_barge_in`.
        super().__init__(
            instructions=self._base_instructions, tools=tools, allow_interruptions=False
        )

    async def on_enter(self) -> None:
        if self._profile.greeting:
            self.session.say(self._profile.greeting)

    # -- who is talking -------------------------------------------------------------------

    def label_event(self, event: stt.SpeechEvent | str) -> stt.SpeechEvent | str:
        """Prefixes transcripts with the speaker, so the model knows who said what."""
        if not isinstance(event, stt.SpeechEvent) or event.type not in _TEXT_EVENTS:
            return event
        if not event.alternatives or not event.alternatives[0].text.strip():
            return event
        first = event.alternatives[0]
        who = self._speaker()
        if event.type == stt.SpeechEventType.FINAL_TRANSCRIPT:
            if who is not None:
                self._heard = Heard(
                    at=time.monotonic(), text=first.text, identity=who.identity, role=who.role
                )
            self._maybe_barge_in(first.text, who)
        tag = ""
        if len(self._voices) > 1:
            if event.type != stt.SpeechEventType.INTERIM_TRANSCRIPT:
                self.language = pick_language(
                    self.language, first.language, first.text, self._voices
                )
            tag = f"[{self.language}] "
        if who is None and not tag:
            return event
        prefix = f"{who.label()} {tag}".rstrip() if who else tag.rstrip()
        event.alternatives[0] = replace(first, text=f"{prefix}: {first.text}")
        return event

    async def stt_node(
        self, audio: AsyncIterable[rtc.AudioFrame], model_settings: ModelSettings
    ) -> AsyncIterator[stt.SpeechEvent | str]:
        events: Any = Agent.default.stt_node(self, audio, model_settings)
        if asyncio.iscoroutine(events):
            events = await events
        if events is None:
            return
        async for event in events:
            yield self.label_event(event)

    async def on_user_turn_completed(
        self, turn_ctx: llm.ChatContext, new_message: llm.ChatMessage
    ) -> None:
        """Silent or "when named" agents only react when someone says their name."""
        text = new_message.text_content or ""
        # With other assistants in the call, answering everything would make them talk over
        # each other: each one waits for its name (or for the floor to be handed to it).
        quiet = self.muted or self._profile.respond_mode == "when_named" or bool(self.peers)
        if quiet and not is_addressed(text, self._profile.name, self.peers):
            raise StopResponse()
        if who := self._speaker():
            self._engagement.touch(who.identity)

    def current_speaker(self) -> Talker | None:
        return self._speaker()

    def last_heard(self) -> Heard | None:
        return self._heard

    def on_lobby_knock(self) -> None:
        """Someone asked to join: an agent that answers the waiting room tells the meeting."""
        if not self._moderates_lobby or self.muted:
            return
        try:
            self.session.generate_reply(instructions=KNOCK_PROMPT)
        except RuntimeError:
            return

    def _maybe_barge_in(self, text: str, who: Talker | None) -> bool:
        """Stops the agent's current speech for a complete utterance from a participant."""
        try:
            session = self.session
        except RuntimeError:
            return False
        speech = session.current_speech
        if speech is None or speech.interrupted or speech.done() or who is None:
            return False
        if not should_interrupt(
            text,
            identity=who.identity,
            role=who.role,
            agent_name=self._profile.name,
            engagement=self._engagement,
            peers=self.peers,
        ):
            return False
        speech.allow_interruptions = True
        session.interrupt()
        logger.info("stopped speaking: a participant took the floor")
        return True

    # -- other assistants in the room -----------------------------------------------------

    def _current_instructions(self) -> str:
        text = self._base_instructions
        if self.peers:
            text += PEERS_NOTE.format(peers=", ".join(self.peers))
        if self.muted:
            text += MUTED_NOTE
        return text

    async def set_peers(self, names: Iterable[str]) -> None:
        peers = tuple(sorted({n for n in names if n and n != self._profile.name}))
        if peers == self.peers:
            return
        self.peers = peers
        await self.update_instructions(self._current_instructions())

    async def take_floor(self, giver: str, request: str) -> None:
        """Another assistant handed over: speak now, unless told to stay quiet."""
        if self.muted:
            return
        self.session.generate_reply(
            instructions=HANDOFF_PROMPT.format(
                giver=giver, request=request or "apresente a sua parte"
            )
        )

    def _handoff_tools(self) -> list[llm.FunctionTool[..., Any]]:
        @llm.function_tool(name="passar_a_vez")
        async def hand_over(assistente: str, pedido: str) -> str:
            """Passa a vez para outro assistente de IA da reunião.

            Args:
                assistente: o nome do outro assistente, como aparece na reunião.
                pedido: o que ele deve fazer agora (por exemplo, apresentar a parte dele).
            """
            if self._handoff is None:
                return "Não é possível passar a vez agora."
            return await self._handoff(assistente, pedido)

        return [hand_over]

    # -- staying quiet (no speech is synthesised, so nothing is billed) --------------------

    def _use_voice_for_language(self) -> None:
        """Switches to the reply language's voice (a no-op with a single voice)."""
        voice = self._voices.get(self.language)
        tts = getattr(self.session, "tts", None)
        if not voice or voice == self._current_voice or tts is None:
            return
        update = getattr(tts, "update_options", None)
        if update is not None:
            update(**voice_options(self._profile.tts_provider, voice, self.language))
            self._current_voice = voice

    async def _voice_for_reply(self, text: AsyncIterable[str]) -> AsyncIterable[str]:
        """Reads the start of the reply, so the voice matches the language actually written."""
        if len(self._voices) < 2:  # noqa: PLR2004
            return text
        chunks = aiter(text)
        head: list[str] = []
        async for chunk in chunks:
            head.append(chunk)
            sofar = "".join(head).rstrip()
            if len(words(sofar)) >= _REPLY_PEEK_WORDS or (sofar and sofar[-1] in ".!?"):
                break
        written = guess_language("".join(head))
        if written in self._voices:
            self.language = written

        async def replay() -> AsyncIterator[str]:
            for chunk in head:
                yield chunk
            async for chunk in chunks:
                yield chunk

        return replay()

    async def tts_node(
        self, text: AsyncIterable[str], model_settings: ModelSettings
    ) -> AsyncIterator[rtc.AudioFrame]:
        if self.muted:
            return
        text = await self._voice_for_reply(text)
        self._use_voice_for_language()
        frames: Any = Agent.default.tts_node(self, text, model_settings)
        if asyncio.iscoroutine(frames):
            frames = await frames
        if frames is None:
            return
        async for frame in frames:
            if self.muted:  # silenced mid-sentence: stop right away
                return
            yield frame

    def may_change_mute(self) -> bool:
        if self._profile.mute_policy == "everyone":
            return True
        who = self._speaker()
        return (
            self._profile.mute_policy == "moderators"
            and who is not None
            and (who.role == "moderator")
        )

    async def set_muted(self, muted: bool) -> None:
        self.muted = muted
        await self.update_instructions(self._current_instructions())
        if self._on_mute is not None:
            await self._on_mute(muted)

    def _mute_tools(self) -> list[llm.FunctionTool[..., Any]]:
        @llm.function_tool(name="silenciar_voz")
        async def mute() -> str:
            """Fica em silêncio: continua ouvindo, mas para de falar até pedirem para voltar."""
            if not self.may_change_mute():
                return "Só moderadores podem pedir isso. Explique com educação."
            await self.set_muted(True)
            return "Você está em silêncio agora. Não diga nada."

        @llm.function_tool(name="ativar_voz")
        async def unmute() -> str:
            """Volta a falar depois de ter ficado em silêncio."""
            if not self.may_change_mute():
                return "Só moderadores podem pedir isso. Continue em silêncio."
            await self.set_muted(False)
            return "Sua voz voltou. Diga em poucas palavras que voltou a falar."

        return [mute, unmute]

    # -- seeing the shared screen ---------------------------------------------------------

    async def see(self, snapshot: Snapshot) -> None:
        """Puts the current screen image in the conversation, replacing the previous one."""
        chat_ctx = self.chat_ctx.copy()
        if self._view_id is not None:
            chat_ctx.items[:] = [item for item in chat_ctx.items if item.id != self._view_id]
        message = chat_ctx.add_message(
            role="user",
            content=[
                "[Imagem da tela que você está mostrando agora na reunião]",
                llm.ImageContent(
                    image=f"data:image/jpeg;base64,{snapshot.image_b64}", inference_detail="low"
                ),
            ],
        )
        self._view_id = message.id
        await self.update_chat_ctx(chat_ctx)
