from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any
from unittest.mock import AsyncMock

import pytest
from livekit.agents import Agent, StopResponse, llm, stt

from meet_impar_agent.persona import (
    MUTE_INSTRUCTIONS,
    MUTED_NOTE,
    SPEAKER_INSTRUCTIONS,
    Talker,
    VoiceAgent,
)
from meet_impar_agent.screen import Snapshot

from .test_main import message, profile

ANA = Talker(name="Ana", role="moderator")
BIA = Talker(name="Bia", role="guest")


def event(kind: stt.SpeechEventType, text: str = "") -> stt.SpeechEvent:
    alternatives = [stt.SpeechData(language="pt", text=text)] if text else []
    return stt.SpeechEvent(type=kind, alternatives=alternatives)


def speaking(who: Talker | None) -> Any:
    return lambda: who


async def collect(stream: AsyncIterator[Any]) -> list[Any]:
    return [item async for item in stream]


class TestSpeakers:
    def test_labels(self) -> None:
        assert ANA.label() == "Ana (moderador)"
        assert BIA.label() == "Bia (convidado)"
        assert Talker("Caio", "something").label() == "Caio (participante)"

    def test_transcripts_carry_who_is_speaking(self) -> None:
        agent = VoiceAgent(profile(), speaker=speaking(ANA))
        final = agent.label_event(event(stt.SpeechEventType.FINAL_TRANSCRIPT, "bom dia"))
        assert isinstance(final, stt.SpeechEvent)
        assert final.alternatives[0].text == "Ana (moderador): bom dia"
        interim = agent.label_event(event(stt.SpeechEventType.INTERIM_TRANSCRIPT, "bo"))
        assert isinstance(interim, stt.SpeechEvent)
        assert interim.alternatives[0].text == "Ana (moderador): bo"

        end = event(stt.SpeechEventType.END_OF_SPEECH)
        assert agent.label_event(end) is end
        blank = event(stt.SpeechEventType.FINAL_TRANSCRIPT, "  ")
        assert agent.label_event(blank).alternatives[0].text == "  "  # type: ignore[union-attr]
        assert agent.label_event("raw text") == "raw text"
        nobody = VoiceAgent(profile())
        plain = nobody.label_event(event(stt.SpeechEventType.FINAL_TRANSCRIPT, "oi"))
        assert plain.alternatives[0].text == "oi"  # type: ignore[union-attr]

    def test_instructions_explain_the_format(self) -> None:
        agent = VoiceAgent(profile(instructions="Você é o Kaiser."))
        assert agent.instructions.startswith("Você é o Kaiser.\n\n")
        assert SPEAKER_INSTRUCTIONS in agent.instructions

    @pytest.mark.parametrize("returns_coroutine", [False, True])
    async def test_stt_node_labels_the_default_pipeline(
        self, monkeypatch: pytest.MonkeyPatch, returns_coroutine: bool
    ) -> None:
        async def events(*_: Any) -> AsyncIterator[stt.SpeechEvent]:
            yield event(stt.SpeechEventType.FINAL_TRANSCRIPT, "olá")

        async def wrapped(*args: Any) -> AsyncIterator[stt.SpeechEvent]:
            return events(*args)

        monkeypatch.setattr(Agent.default, "stt_node", wrapped if returns_coroutine else events)
        agent = VoiceAgent(profile(), speaker=speaking(BIA))
        out = await collect(agent.stt_node(AsyncMock(), AsyncMock()))  # type: ignore[arg-type]
        assert [e.alternatives[0].text for e in out] == ["Bia (convidado): olá"]

    async def test_stt_node_without_output(self, monkeypatch: pytest.MonkeyPatch) -> None:
        async def nothing(*_: Any) -> None:
            return None

        monkeypatch.setattr(Agent.default, "stt_node", nothing)
        agent = VoiceAgent(profile())
        assert await collect(agent.stt_node(AsyncMock(), AsyncMock())) == []  # type: ignore[arg-type]


class TestMute:
    @pytest.fixture
    def frames(self, monkeypatch: pytest.MonkeyPatch) -> list[str]:
        produced: list[str] = []

        async def tts(*_: Any) -> AsyncIterator[str]:
            for f in ("f1", "f2", "f3"):
                produced.append(f)
                yield f

        monkeypatch.setattr(Agent.default, "tts_node", tts)
        return produced

    def agent(self, policy: str = "everyone", who: Talker | None = ANA) -> VoiceAgent:
        agent = VoiceAgent(profile(mute_policy=policy), speaker=speaking(who))
        agent.update_instructions = AsyncMock()  # type: ignore[method-assign]
        return agent

    async def test_muted_agent_synthesises_nothing(self, frames: list[str]) -> None:
        agent = self.agent()
        assert await collect(agent.tts_node(AsyncMock(), AsyncMock())) == ["f1", "f2", "f3"]  # type: ignore[arg-type]
        agent.muted = True
        frames.clear()
        assert await collect(agent.tts_node(AsyncMock(), AsyncMock())) == []  # type: ignore[arg-type]
        assert frames == []  # the TTS provider was never called

    async def test_muting_mid_sentence_cuts_the_speech(self, frames: list[str]) -> None:
        agent = self.agent()
        stream = agent.tts_node(AsyncMock(), AsyncMock())  # type: ignore[arg-type]
        assert await anext(stream) == "f1"
        agent.muted = True
        assert await collect(stream) == []

    async def test_tts_node_coroutine_and_empty_defaults(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def gen(*_: Any) -> AsyncIterator[str]:
            yield "x"

        async def coro(*args: Any) -> AsyncIterator[str]:
            return gen(*args)

        agent = self.agent()
        monkeypatch.setattr(Agent.default, "tts_node", coro)
        assert await collect(agent.tts_node(AsyncMock(), AsyncMock())) == ["x"]  # type: ignore[arg-type]

        async def none(*_: Any) -> None:
            return None

        monkeypatch.setattr(Agent.default, "tts_node", none)
        assert await collect(agent.tts_node(AsyncMock(), AsyncMock())) == []  # type: ignore[arg-type]

    async def test_silent_agent_only_reacts_when_named(self) -> None:
        agent = self.agent()
        agent.muted = True
        with pytest.raises(StopResponse):
            await agent.on_user_turn_completed(llm.ChatContext(), message("Ana (moderador): e aí?"))
        await agent.on_user_turn_completed(
            llm.ChatContext(), message("Ana (moderador): Kaiser, pode falar")
        )

    async def test_anyone_can_mute_and_unmute_by_default(self) -> None:
        on_mute = AsyncMock()
        agent = VoiceAgent(profile(), speaker=speaking(BIA), on_mute=on_mute)
        agent.update_instructions = AsyncMock()  # type: ignore[method-assign]
        tools = {t.info.name: t for t in agent.tools}
        assert MUTE_INSTRUCTIONS["everyone"] in agent.instructions

        assert "silêncio" in await tools["silenciar_voz"]()
        assert agent.muted
        assert agent.update_instructions.await_args.args[0].endswith(MUTED_NOTE)
        assert "voltou" in await tools["ativar_voz"]()
        assert not agent.muted
        assert not agent.update_instructions.await_args.args[0].endswith(MUTED_NOTE)
        assert [c.args[0] for c in on_mute.await_args_list] == [True, False]

    @pytest.mark.parametrize(("who", "allowed"), [(ANA, True), (BIA, False), (None, False)])
    async def test_moderators_only_policy(self, who: Talker | None, allowed: bool) -> None:
        agent = self.agent("moderators", who)
        tools = {t.info.name: t for t in agent.tools}
        assert "Só moderadores" in agent.instructions
        answer = await tools["silenciar_voz"]()
        assert agent.muted is allowed
        assert ("Só moderadores" in answer) is not allowed
        agent.muted = True
        answer = await tools["ativar_voz"]()
        assert agent.muted is not allowed

    def test_disabled_policy_has_no_mute_tools(self) -> None:
        agent = self.agent("disabled")
        assert agent.tools == []
        assert "silenciar_voz" not in agent.instructions


async def test_the_agent_sees_only_the_latest_screen() -> None:
    agent = VoiceAgent(profile())
    contexts: list[llm.ChatContext] = []

    async def update(chat_ctx: llm.ChatContext) -> None:
        contexts.append(chat_ctx)
        agent._chat_ctx = chat_ctx

    agent.update_chat_ctx = update  # type: ignore[method-assign]
    await agent.see(Snapshot("AAAA", "Primeira", "https://a.example", "um"))
    await agent.see(Snapshot("BBBB", "Segunda", "https://b.example", "dois"))

    images = [
        part
        for item in contexts[-1].items
        if isinstance(item, llm.ChatMessage)
        for part in item.content
        if isinstance(part, llm.ImageContent)
    ]
    assert [i.image for i in images] == ["data:image/jpeg;base64,BBBB"]
    assert images[0].inference_detail == "low"
