from __future__ import annotations

import asyncio
import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import httpx
from livekit import rtc
from livekit.agents import llm
from pydantic import SecretStr

from meet_impar_agent import main
from meet_impar_agent.config import PlatformSettings
from meet_impar_agent.insights import (
    COPILOT_TOPIC,
    MAX_LINES,
    Copilot,
    MeetingRecord,
    clean_access,
    clean_insights,
    insights_attributes,
    llm_answer,
    send_report,
)
from meet_impar_agent.profile import AgentProfile, profile_from_platform

from .test_agent_credentials import REMOTE

PLATFORM = PlatformSettings(url="http://platform:3000", token=SecretStr("tok"))  # type: ignore[arg-type]


def test_talk_time_turns_words_and_presence_add_up() -> None:
    r = MeetingRecord(keep_lines=True, started_at=1000.0)
    r.joined("u-ana", "Ana", "moderator", now=1000)
    r.joined("g-eva", "Eva", "guest", now=1010)
    r.speakers({"u-ana"}, now=1020)
    r.speakers({"u-ana", "g-eva", "ghost"}, now=1050)  # Ana 30 s; unknown identities ignored
    r.speakers(set(), now=1060)  # both 10 s more
    r.heard("u-ana", "Ana", "moderator", "Vamos começar a reunião", now=1021)
    r.heard("g-eva", "Eva", "guest", "Oi", now=1055)
    r.said("Kaiser", "Olá a todos", now=1056)
    r.left("g-eva", now=1100)
    m = r.metrics(now=1120)
    assert m["durationS"] == 120
    assert m["people"] == [
        {"name": "Ana", "talkSeconds": 40, "share": 80, "turns": 1, "present": True},
        {"name": "Eva", "talkSeconds": 10, "share": 20, "turns": 1, "present": False},
    ]
    assert r.people["u-ana"].words == 4
    assert [line["name"] for line in r.lines] == ["Ana", "Eva", "Kaiser"]
    assert r.lines[0] == {
        "at": 21.0,
        "identity": "u-ana",
        "name": "Ana",
        "text": "Vamos começar a reunião",
    }

    report = r.report("t1.sala", include_lines=False, now=1130)
    assert report["room"] == "t1.sala"
    assert report["lines"] == []
    eva = next(p for p in report["participants"] if p["identity"] == "g-eva")
    assert eva == {
        "identity": "g-eva",
        "name": "Eva",
        "role": "guest",
        "talkSeconds": 10.0,
        "turns": 1,
        "words": 1,
        "joinedAt": 1010,
        "leftAt": 1100,
    }
    assert len(r.report("t1.sala", include_lines=True, now=1130)["lines"]) == 3
    r.joined("g-eva", "Eva", "guest", now=1200)  # came back
    assert r.people["g-eva"].left_at is None


def test_the_conversation_is_kept_only_when_needed_and_bounded() -> None:
    quiet = MeetingRecord(keep_lines=False, started_at=0.0)
    quiet.heard("u-a", "A", "participant", "olá", now=1)
    assert quiet.lines == []
    assert quiet.people["u-a"].turns == 1

    full = MeetingRecord(keep_lines=True, started_at=0.0)
    for i in range(MAX_LINES + 5):
        full.heard("u-a", "A", "participant", f"fala {i}", now=i)
    assert len(full.lines) == MAX_LINES
    full.heard("u-a", "A", "participant", "   ", now=1)
    assert full.transcript(limit=40).count("\n") <= 2
    assert full.transcript(before=2).endswith("[00:02] A: fala 2")
    long = MeetingRecord(keep_lines=True, started_at=0.0)
    long.heard("u-a", "A", "participant", "x", now=4000)
    assert long.transcript() == "[1:06:40] A: x"


async def test_the_report_goes_to_the_platform_with_the_internal_token() -> None:
    seen: list[httpx.Request] = []

    def ok(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(201, json={"id": "r1"})

    r = MeetingRecord(keep_lines=True, started_at=0.0)
    assert not await send_report(PLATFORM, "ag-1", r.report("t1.sala", include_lines=True, now=1))
    r.joined("u-a", "A", "participant", now=0)
    report = r.report("t1.sala", include_lines=True, now=1)
    assert await send_report(PLATFORM, "ag-1", report, transport=httpx.MockTransport(ok))
    assert str(seen[0].url) == "http://platform:3000/api/internal/agents/ag-1/report"
    assert seen[0].headers["x-internal-token"] == "tok"
    assert json.loads(seen[0].content)["participants"][0]["identity"] == "u-a"

    def down(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    assert not await send_report(PLATFORM, "ag-1", report, transport=httpx.MockTransport(down))


def person(identity: str, name: str, *, role: str = "", org: str = "", agent: bool = False) -> Any:
    p = MagicMock()
    p.identity = identity
    p.name = name
    p.attributes = {k: v for k, v in (("role", role), ("impa.org", org)) if v}
    p.kind = (
        rtc.ParticipantKind.PARTICIPANT_KIND_AGENT
        if agent
        else rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD
    )
    return p


def copilot(
    *people: Any,
    enabled: tuple[str, ...] = ("catchup", "copilot", "metrics"),
    access: str = "moderators",
    answer: Any = None,
) -> tuple[Copilot, MagicMock]:
    room = MagicMock()
    room.remote_participants = {p.identity: p for p in people}
    room.local_participant.send_text = AsyncMock()
    record = MeetingRecord(keep_lines=True, started_at=1000.0)
    record.joined("u-ana", "Ana", "moderator", now=1000)
    record.heard("u-ana", "Ana", "moderator", "Fechamos o preço em 99 reais", now=1010)

    async def default(system: str, user: str) -> str:
        return f"[{system[:20]}] {user[-40:]}"

    clock = [0.0]
    c = Copilot(room, record, enabled, access, answer or default, clock=lambda: clock[0])
    return c, room


ANA = person("u-ana", "Ana", role="moderator", org="member")
BIA = person("u-bia", "Bia", role="participant", org="member")
GIL = person("u-gil", "Gil", role="participant", org="manager")
EVA = person("g-eva", "Eva", role="guest")
BOT = person("agent-1", "Outro", agent=True)


async def test_moderators_and_managers_get_private_answers_others_do_not() -> None:
    c, room = copilot(ANA, BIA, GIL, EVA, BOT)
    ask = json.dumps({"id": "q1", "type": "ask", "text": "Qual foi o preço?"})
    answer = await c.handle(ask, "u-ana")
    assert answer is not None
    assert answer["type"] == "answer"
    assert answer["id"] == "q1"
    assert "Pergunta de Ana: Qual foi o preço?" in answer["text"]
    room.local_participant.send_text.assert_awaited_with(
        json.dumps(answer, ensure_ascii=False),
        topic=COPILOT_TOPIC,
        destination_identities=["u-ana"],
    )
    assert (await c.handle(ask, "u-gil"))["type"] == "answer"  # type: ignore[index]
    for who in ("u-bia", "g-eva"):
        assert await c.handle(ask, who) == {"id": "q1", "type": "error", "code": "forbidden"}
    assert await c.handle(ask, "agent-1") is None  # assistants never ask
    assert await c.handle(ask, "u-gone") is None
    assert await c.handle("{bad", "u-ana") is None
    assert await c.handle("[1]", "u-ana") is None

    metrics = await c.handle(json.dumps({"type": "metrics"}), "u-ana")
    assert metrics is not None
    assert metrics["type"] == "metrics"
    assert metrics["people"][0]["name"] == "Ana"
    assert (await c.handle(json.dumps({"type": "metrics"}), "u-bia"))["code"] == "forbidden"  # type: ignore[index]


async def test_managers_only_and_what_was_turned_on() -> None:
    c, _ = copilot(ANA, GIL, access="managers")
    ask = json.dumps({"type": "ask", "text": "resumo?"})
    assert (await c.handle(ask, "u-ana"))["code"] == "forbidden"  # type: ignore[index]
    assert (await c.handle(ask, "u-gil"))["type"] == "answer"  # type: ignore[index]

    prompts: list[str] = []

    async def remember(system: str, user: str) -> str:
        prompts.append(user)
        return "Resumo"

    only_catchup, _ = copilot(ANA, EVA, enabled=("catchup",), answer=remember)
    assert (await only_catchup.handle(ask, "u-ana"))["code"] == "unavailable"  # type: ignore[index]
    only_catchup.record.joined("g-eva", "Eva", "guest", now=1600)
    late = await only_catchup.handle(json.dumps({"type": "catchup"}), "g-eva")
    assert late is not None
    assert late["text"] == "Resumo"
    assert prompts[0].startswith("Eva entrou aos 10:00 de reunião.")
    assert "Ana: Fechamos o preço em 99 reais" in prompts[0]
    assert (await only_catchup.handle(json.dumps({"type": "nope"}), "g-eva"))[
        "code"
    ] == "unavailable"  # type: ignore[index]
    empty = await c.handle(json.dumps({"type": "ask", "text": "   "}), "u-gil")
    assert empty is not None
    assert empty["code"] == "empty"


async def test_catchup_with_nothing_said_and_failures_never_break_the_meeting() -> None:
    c, _ = copilot(EVA)
    c.record.lines.clear()
    assert await c.handle(json.dumps({"type": "catchup"}), "g-eva") == {
        "id": "",
        "type": "answer",
        "text": "",
        "empty": True,
    }

    async def broken(system: str, user: str) -> str:
        raise RuntimeError("llm down")

    failing, _ = copilot(ANA, answer=broken)
    assert (await failing.handle(json.dumps({"type": "ask", "text": "x"}), "u-ana"))[
        "code"
    ] == "failed"  # type: ignore[index]

    limited, _ = copilot(ANA)
    codes = [
        (await limited.handle(json.dumps({"type": "ask", "text": "x"}), "u-ana"))["type"]  # type: ignore[index]
        for _ in range(8)
    ]
    assert codes.count("answer") == 6
    assert (await limited.handle(json.dumps({"type": "ask", "text": "x"}), "u-ana"))[
        "code"
    ] == "too_many"  # type: ignore[index]

    off, _ = copilot(ANA)
    off.allowed_now = lambda: False
    assert (await off.handle(json.dumps({"type": "metrics"}), "u-ana"))["code"] == "actions_off"  # type: ignore[index]


async def test_the_private_answer_comes_from_the_agents_own_llm() -> None:
    seen: list[llm.ChatContext] = []

    class Fake:
        def chat(self, *, chat_ctx: llm.ChatContext) -> Any:
            seen.append(chat_ctx)
            stream = MagicMock()
            stream.collect = AsyncMock(return_value=llm.CollectedResponse(text="  resposta  "))
            return stream

    answer = llm_answer(Fake())  # type: ignore[arg-type]
    assert await answer("sistema", "pergunta") == "resposta"
    roles = [m.role for m in seen[0].items]  # type: ignore[union-attr]
    assert roles == ["system", "user"]


def test_the_admin_choices_reach_the_agent_and_the_browsers() -> None:
    assert clean_insights(["metrics", "x", "minutes"]) == ("minutes", "metrics")
    assert clean_insights("minutes") == ()
    assert clean_access("managers") == "managers"
    assert clean_access("everyone") == "moderators"
    p = profile_from_platform(REMOTE | {"insights": ["copilot"], "insightsAccess": "managers"})
    assert p is not None
    assert (p.insights, p.insights_access) == (("copilot",), "managers")
    assert insights_attributes(("minutes",), "moderators") == {}
    assert insights_attributes(("minutes", "copilot", "metrics"), "managers") == {
        "impa.insights": "copilot,metrics",
        "impa.insights.access": "managers",
    }


def profile(**overrides: Any) -> AgentProfile:
    base: dict[str, Any] = {
        "name": "Kaiser",
        "instructions": "x",
        "greeting": "",
        "voice_id": None,
        "tts_model": "s2.1-pro",
        "llm_model": "m",
        "stt_model": "transcribe-stream-1",
        "llm_base_url": "https://llm.example.com/v1",
        "llm_api_key": "sk-test-0123456789",
        "tts_api_key": "fish-test-0123456789",
        "stt_api_key": "fish-test-0123456789",
        "voices": {"pt": "voz-kaiser"},
        "mute_policy": "disabled",
    }
    return AgentProfile(**(base | overrides))


async def test_the_agent_follows_the_room_for_the_record_and_the_copilot() -> None:
    assert main.meeting_record(profile()) is None
    metrics_only = main.meeting_record(profile(insights=("metrics",)))
    assert metrics_only is not None
    assert metrics_only.keep_lines is False
    record = main.meeting_record(profile(insights=("minutes",)))
    assert record is not None
    assert record.keep_lines is True

    room = MagicMock()
    room.remote_participants = {"u-ana": ANA, "agent-1": BOT}
    handlers: dict[str, Any] = {}
    room.on.side_effect = handlers.__setitem__
    session = MagicMock()
    session_handlers: dict[str, Any] = {}
    session.on.side_effect = session_handlers.__setitem__
    main.follow_record(room, session, record, "Kaiser")
    assert set(record.people) == {"u-ana"}
    handlers["participant_connected"](EVA)
    handlers["participant_connected"](BOT)
    assert set(record.people) == {"u-ana", "g-eva"}
    handlers["active_speakers_changed"]([ANA])
    handlers["participant_disconnected"](EVA)
    assert record.people["g-eva"].left_at is not None
    item = MagicMock(role="assistant", text_content="Olá")
    session_handlers["conversation_item_added"](MagicMock(item=item))
    session_handlers["conversation_item_added"](MagicMock(item=MagicMock(role="user")))
    assert [line["name"] for line in record.lines] == ["Kaiser"]

    c, croom = copilot(ANA)
    streams: dict[str, Any] = {}
    croom.register_text_stream_handler.side_effect = streams.__setitem__
    main.follow_copilot(croom, c)
    reader = MagicMock()
    reader.read_all = AsyncMock(return_value=json.dumps({"id": "m", "type": "metrics"}))
    streams[COPILOT_TOPIC](reader, "u-ana")
    for _ in range(10):
        await asyncio.sleep(0)
    croom.local_participant.send_text.assert_awaited()
