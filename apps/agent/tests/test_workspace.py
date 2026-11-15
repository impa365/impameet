"""Shared work board the agent publishes during a meeting."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from meet_impar_agent.workspace import ACTIONS_OFF, Workspace, WorkspaceState, workspace_tools


class Host:
    def __init__(self, allowed: bool = True) -> None:
        self.allowed = allowed

    def actions_allowed(self) -> bool:
        return self.allowed


def test_state_merge_and_replace() -> None:
    state = WorkspaceState()
    state.apply(title="Evento", plan=["A"], decisions=["D1"], merge=True)
    state.apply(plan=["A", "B"], tasks=[{"task": "T1", "owner": "Ana", "due": ""}], merge=True)
    assert state.title == "Evento"
    assert state.plan == ["A", "B"]
    assert state.decisions == ["D1"]
    assert state.tasks == [{"task": "T1", "owner": "Ana", "due": ""}]
    state.apply(plan=["X"], merge=False)
    assert state.plan == ["X"]
    assert not state.empty()


@pytest.mark.asyncio
async def test_workspace_tools_publish() -> None:
    room = MagicMock()
    room.local_participant.send_text = AsyncMock()
    board = Workspace(room)
    tools = {t.info.name: t for t in workspace_tools(board, Host())}
    assert set(tools) == {"atualizar_workspace", "limpar_workspace"}

    result = await tools["atualizar_workspace"](
        "Plano", ["1", "2"], ["ok"], [{"task": "fazer"}], "", False
    )
    assert "atualizado" in result.lower()
    assert board.state.title == "Plano"
    assert board.state.plan == ["1", "2"]
    room.local_participant.send_text.assert_awaited()
    payload = json.loads(room.local_participant.send_text.await_args.args[0])
    assert payload["title"] == "Plano"
    assert payload["plan"] == ["1", "2"]

    cleared = await tools["limpar_workspace"]()
    assert "limpo" in cleared.lower()
    assert board.state.empty()


@pytest.mark.asyncio
async def test_workspace_respects_actions_off() -> None:
    room = MagicMock()
    room.local_participant.send_text = AsyncMock()
    board = Workspace(room)
    tools = {t.info.name: t for t in workspace_tools(board, Host(False))}
    msg = await tools["atualizar_workspace"]("X", ["a"], None, None, "", False)
    assert msg == ACTIONS_OFF
    assert board.state.empty()
    assert room.local_participant.send_text.await_count == 0
