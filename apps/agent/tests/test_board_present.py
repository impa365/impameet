from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock

from meet_impar_agent import board_present, main
from meet_impar_agent.perception import (
    ACTIONS_OFF_PRESENT,
    BOARD_TOPIC,
    Perception,
    perception_note,
    perception_tools,
)
from meet_impar_agent.profile import clean_perception

from .test_perception import Host, participant


def drawn(eid: str, x: float, width: float, index: str, *, y: float = 50.0) -> dict[str, Any]:
    return {
        "id": eid,
        "type": "rectangle",
        "x": x,
        "y": y,
        "width": width,
        "height": 40,
        "version": 3,
        "versionNonce": 7,
        "index": index,
    }


def test_a_presentation_is_native_text_in_reading_order() -> None:
    elements = board_present.presentation("Plano", ["Um", "Dois", "  ", "Três"], [], "Kaiser")
    assert [e["text"] for e in elements] == ["Plano", "• Um", "• Dois", "• Três"]
    assert all(e["type"] == "text" and board_present.is_own(e) for e in elements)
    assert all(e["customData"]["author"] == "Kaiser" for e in elements)
    assert [e["index"] for e in elements] == ["a0", "a1", "a2", "a3"]
    ys = [e["y"] for e in elements]
    assert ys == sorted(ys)
    assert len({e["groupIds"][0] for e in elements}) == 1
    # Everything Excalidraw needs to draw a text element is there.
    for key in ("version", "versionNonce", "seed", "fontFamily", "lineHeight", "originalText"):
        assert key in elements[0]


def test_it_goes_beside_what_people_drew_and_after_their_order() -> None:
    board = [drawn("ana-1", 0, 300, "a5"), drawn("ana-2", 400, 100, "a7", y=-20)]
    elements = board_present.presentation("T", ["x"], board, "IA")
    assert min(e["x"] for e in elements) == 500 + board_present.GAP
    assert elements[0]["y"] == -20
    assert [e["index"] for e in elements] == ["a71", "a72"]
    assert all(e["index"] > "a7" for e in elements)


def test_a_new_presentation_replaces_only_the_agents_own() -> None:
    first = board_present.presentation("A", ["1"], [], "IA")
    forged = {**drawn("ai-fake", 0, 10, "a9"), "customData": {"agent": False}}
    board = [*first, drawn("ana-1", 0, 10, "a8"), forged]
    second = board_present.presentation("B", ["2"], board, "IA")
    retired = [e for e in second if e["isDeleted"]]
    assert {e["id"] for e in retired} == {e["id"] for e in first}
    assert all(e["version"] == 2 for e in retired)
    assert "ana-1" not in {e["id"] for e in second}
    assert "ai-fake" not in {e["id"] for e in second}
    assert board_present.retire([drawn("ana-1", 0, 10, "a0")]) == []


def test_long_text_is_trimmed_and_wrapped() -> None:
    title, topics = board_present.clean("t" * 500, [f"tópico {n}" for n in range(12)])
    assert len(title) == board_present.MAX_TITLE
    assert len(topics) == board_present.MAX_TOPICS
    long = board_present.presentation("T", ["palavra " * 30], [], "IA")[1]
    assert "\n" in long["text"]
    assert long["height"] > board_present.TOPIC_SIZE * board_present.LINE_HEIGHT
    assert board_present.outline("Plano", ["um", "dois"]) == "Plano\n• um\n• dois"


def view(allowed: tuple[str, ...] = ("present",)) -> tuple[Perception, MagicMock]:
    room = MagicMock()
    room.remote_participants = {"u-ana": participant("u-ana", "Ana")}
    room.local_participant.send_text = AsyncMock()
    return Perception(room, allowed, author="Kaiser"), room


async def test_the_agent_writes_on_the_board_and_removes_only_its_own() -> None:
    perception, room = view()
    perception.on_board(
        json.dumps({"type": "scene", "elements": [drawn("ana-1", 0, 100, "a0")]}), "u-ana"
    )
    host = Host()
    tools = {t.info.name: t for t in perception_tools(perception, host)}
    assert set(tools) == {"apresentar_no_quadro", "limpar_apresentacao_do_quadro"}

    answer = await tools["apresentar_no_quadro"]("Plano", ["Um", "Dois"])
    assert "quadro branco" in answer
    assert "• Um" in answer
    call = room.local_participant.send_text.call_args
    assert call.kwargs["topic"] == BOARD_TOPIC
    sent = json.loads(call.args[0])
    assert sent["type"] == "scene"
    assert [e["text"] for e in sent["elements"]] == ["Plano", "• Um", "• Dois"]
    assert "Plano" in perception.board.describe()
    assert perception.board.authors[sent["elements"][0]["id"]] == "Kaiser"

    assert await tools["limpar_apresentacao_do_quadro"]() == "Tirei a sua apresentação do quadro."
    cleared = json.loads(room.local_participant.send_text.call_args.args[0])["elements"]
    assert {e["id"] for e in cleared} == {e["id"] for e in sent["elements"]}
    assert all(e["isDeleted"] for e in cleared)
    assert not perception.board.elements["ana-1"].get("isDeleted")
    assert await tools["limpar_apresentacao_do_quadro"]() == "Não há apresentação sua no quadro."
    assert "pelo menos um tópico" in await tools["apresentar_no_quadro"]("Plano", [])

    host.actions = False
    calls = room.local_participant.send_text.call_count
    assert await tools["apresentar_no_quadro"]("X", ["y"]) == ACTIONS_OFF_PRESENT
    assert await tools["limpar_apresentacao_do_quadro"]() == ACTIONS_OFF_PRESENT
    assert room.local_participant.send_text.call_count == calls


async def test_presenting_is_its_own_permission_and_follows_the_board() -> None:
    assert clean_perception(["present", "board", "nope"]) == ("board", "present")
    assert "apresentar_no_quadro" in perception_note(("present",))
    assert "ver_quadro" not in perception_note(("present",))
    seeing, _ = view(("board",))
    assert "apresentar_no_quadro" not in {t.info.name for t in perception_tools(seeing, Host())}

    perception, room = view()
    handlers: dict[str, Any] = {}
    room.register_text_stream_handler.side_effect = handlers.__setitem__
    await main.follow_meeting(room, perception)
    assert set(handlers) == {BOARD_TOPIC}
