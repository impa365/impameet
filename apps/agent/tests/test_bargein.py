from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any
from unittest.mock import MagicMock

import pytest
from livekit import rtc
from livekit.agents import stt

from meet_impar_agent import main
from meet_impar_agent.bargein import Engagement, is_complete, should_interrupt
from meet_impar_agent.config import load_settings
from meet_impar_agent.persona import Talker, VoiceAgent
from meet_impar_agent.pipeline import ThinkingAudio, build_thinking_audio, build_turn_handling
from meet_impar_agent.profile import AgentProfile, thinking_sound

ANA = Talker(name="Ana", role="participant", identity="u-ana")
BIA = Talker(name="Bia", role="guest", identity="g-bia")
MOD = Talker(name="Carla", role="moderator", identity="u-carla")


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.mark.parametrize(
    ("text", "complete"),
    [
        ("", False),
        ("hm", False),
        ("uhum", False),
        ("haha kkk", False),
        ("ok tá bom", False),  # three words, but only backchannel
        ("é né", False),
        ("Pode repetir o preço?", True),
        ("Eu acho que isso está errado", True),
        ("Espera", True),  # a short command is complete on its own
        ("para, para", True),
        ("wait", True),
        ("Kaiser, uma pergunta", True),
        ("Can you go back?", True),
    ],
)
def test_only_real_sentences_or_commands_are_complete(text: str, complete: bool) -> None:
    assert is_complete(text, "Kaiser") is complete


def test_who_may_cut_the_agent_off() -> None:
    clock = Clock()
    engaged = Engagement(clock=clock)
    engaged.touch(ANA.identity)

    def check(text: str, who: Talker) -> bool:
        return should_interrupt(
            text, identity=who.identity, role=who.role, agent_name="Kaiser", engagement=engaged
        )

    # (a) noise or fragments never do, even from someone in the conversation
    assert not check("hm", ANA)
    assert not check("ah tá", ANA)
    # (b) a complete sentence from someone taking part does
    assert check("Pode explicar de novo?", ANA)
    assert check("Espera", ANA)
    # (c) a complete sentence from someone outside the conversation does not...
    assert not check("Amor, você viu minha chave?", BIA)
    assert not check("para", BIA)
    # ...unless they address the agent or run the meeting
    assert check("Kaiser, espera um pouco", BIA)
    assert check("Vamos para o próximo assunto", MOD)
    # being in the conversation expires
    clock.now += 301
    assert not check("Pode explicar de novo?", ANA)
    assert not should_interrupt(
        "Pode explicar de novo?",
        identity="",
        role="participant",
        agent_name="Kaiser",
        engagement=engaged,
    )


def profile(**overrides: Any) -> AgentProfile:
    base: dict[str, Any] = {
        "name": "Kaiser",
        "instructions": "x",
        "greeting": "",
        "voice_id": "voz-pt-1",
        "tts_model": "s2.1-pro",
        "llm_model": "m",
        "voices": {"pt": "voz-pt-1"},
    }
    return AgentProfile(**(base | overrides))


@pytest.fixture
def speaking() -> Iterator[tuple[VoiceAgent, MagicMock, MagicMock, list[Talker | None]]]:
    """An agent in the middle of a sentence, listening to whoever `who[0]` is."""
    who: list[Talker | None] = [ANA]
    agent = VoiceAgent(profile(), speaker=lambda: who[0])
    speech = MagicMock(interrupted=False, allow_interruptions=False)
    speech.done.return_value = False
    session = MagicMock(current_speech=speech)
    type(agent).session = property(lambda self: session)  # type: ignore[method-assign]
    try:
        yield agent, session, speech, who
    finally:
        del type(agent).session


def _final(text: str) -> stt.SpeechEvent:
    return stt.SpeechEvent(
        type=stt.SpeechEventType.FINAL_TRANSCRIPT,
        alternatives=[stt.SpeechData(language="pt", text=text)],
    )


def test_the_agent_is_not_interruptible_by_voice_activity() -> None:
    assert VoiceAgent(profile()).allow_interruptions is False
    options = build_turn_handling()
    assert options["interruption"]["discard_audio_if_uninterruptible"] is False  # STT still hears


def test_noise_and_strangers_do_not_stop_the_speech(
    speaking: tuple[VoiceAgent, MagicMock, MagicMock, list[Talker | None]],
) -> None:
    agent, session, speech, who = speaking
    agent._engagement.touch(ANA.identity)

    agent.label_event(_final("hm"))
    who[0] = BIA
    agent.label_event(_final("Amor, cadê o carregador do celular?"))
    who[0] = None
    agent.label_event(_final("Pode repetir, por favor?"))
    session.interrupt.assert_not_called()
    assert speech.allow_interruptions is False


def test_a_participant_sentence_stops_the_speech(
    speaking: tuple[VoiceAgent, MagicMock, MagicMock, list[Talker | None]],
) -> None:
    agent, session, speech, _ = speaking
    agent._engagement.touch(ANA.identity)

    interim = stt.SpeechEvent(
        type=stt.SpeechEventType.INTERIM_TRANSCRIPT,
        alternatives=[stt.SpeechData(language="pt", text="Pode repetir")],
    )
    agent.label_event(interim)  # still talking: wait for the finished sentence
    session.interrupt.assert_not_called()

    event = agent.label_event(_final("Pode repetir o valor, por favor?"))
    session.interrupt.assert_called_once()
    assert speech.allow_interruptions is True
    assert isinstance(event, stt.SpeechEvent)
    assert event.alternatives[0].text.startswith("Ana (participante): ")


def test_nothing_to_stop_when_the_agent_is_quiet(
    speaking: tuple[VoiceAgent, MagicMock, MagicMock, list[Talker | None]],
) -> None:
    agent, session, speech, _ = speaking
    agent._engagement.touch(ANA.identity)
    session.current_speech = None
    assert agent._maybe_barge_in("Pode repetir o valor?", ANA) is False
    session.current_speech = speech
    speech.interrupted = True
    assert agent._maybe_barge_in("Pode repetir o valor?", ANA) is False
    session.interrupt.assert_not_called()
    assert VoiceAgent(profile())._maybe_barge_in("Pode repetir o valor?", ANA) is False


async def test_answered_turns_make_the_speaker_part_of_the_conversation(
    speaking: tuple[VoiceAgent, MagicMock, MagicMock, list[Talker | None]],
) -> None:
    agent, _, _, who = speaking
    who[0] = BIA
    assert not agent._engagement.engaged(BIA.identity)
    message = MagicMock(text_content="Bia (convidado): Qual é o horário?")
    await agent.on_user_turn_completed(MagicMock(), message)
    assert agent._engagement.engaged(BIA.identity)


# -- the typing sound ---------------------------------------------------------------------


def test_rooms_switch_the_typing_sound_with_the_dispatch() -> None:
    assert thinking_sound(json.dumps({"agentId": "a", "thinkingSound": False})) is False
    assert thinking_sound(json.dumps({"agentId": "a", "thinkingSound": True})) is True
    assert thinking_sound(json.dumps({"agentId": "a"})) is True  # older dispatches: on
    assert thinking_sound("not json") is True


async def test_the_typing_sound_follows_the_room_switch(env: dict[str, str]) -> None:
    audio = build_thinking_audio(load_settings(env).agent, enabled=False)
    assert isinstance(audio, ThinkingAudio)
    assert audio.enabled is False
    handle = MagicMock()
    audio._thinking_handle = handle
    audio._agent_state_changed(MagicMock(new_state="thinking"))
    handle.stop.assert_called_once()  # off: nothing plays

    audio.play = MagicMock(return_value=MagicMock())  # type: ignore[method-assign]
    audio.set_enabled(True)
    audio._thinking_handle = None
    audio._agent_state_changed(MagicMock(new_state="thinking"))
    audio.play.assert_called_once()

    playing = MagicMock()
    audio._thinking_handle = playing
    audio.set_enabled(False)  # switched off mid-sound: it stops right away
    playing.stop.assert_called_once()


def test_room_setting_messages_reach_the_typing_sound() -> None:
    room = MagicMock()
    audio = MagicMock()
    main.follow_room_settings(room, audio)
    on_data = room.on.call_args.args[1]

    def packet(
        data: object, *, topic: str = main.AGENT_SETTINGS_TOPIC, sender: object = None
    ) -> Any:
        raw = data if isinstance(data, bytes) else json.dumps(data).encode()
        return MagicMock(spec=rtc.DataPacket, data=raw, topic=topic, participant=sender)

    on_data(packet({"thinkingSound": False}))
    audio.set_enabled.assert_called_once_with(False)
    on_data(packet({"thinkingSound": True}, sender=MagicMock()))  # a participant cannot
    on_data(packet({"thinkingSound": True}, topic="impa.policy"))
    on_data(packet(b"not json"))
    on_data(packet({"thinkingSound": "yes"}))
    audio.set_enabled.assert_called_once()
