"""Shared work product the agent builds during a meeting: plan, decisions, tasks and notes.

Published on a LiveKit text topic so every browser can show the same board. The agent is the
author; people read it. A snapshot goes with the meeting report when the meeting ends.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any, Protocol

from livekit import rtc
from livekit.agents import llm

logger = logging.getLogger("meet_impar_agent.workspace")

WORKSPACE_TOPIC = "impa.workspace"
MAX_TITLE = 160
MAX_ITEMS = 40
MAX_ITEM = 400
MAX_NOTES = 4000

WORKSPACE_NOTE = (
    "QUADRO DE TRABALHO: você mantém um quadro compartilhado da reunião (plano, decisões, "
    "tarefas e notas) que todos veem. Quando pedirem um plano, cronograma, próximos passos, "
    "para anotar uma decisão ou tarefa, use atualizar_workspace. Não diga que vai anotar sem "
    "chamar a ferramenta. limpar_workspace só quando pedirem para começar de novo."
)


def _clean_list(raw: object, *, max_items: int = MAX_ITEMS, max_chars: int = MAX_ITEM) -> list[str]:
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    for item in raw[:max_items]:
        text = str(item).strip()[:max_chars] if item is not None else ""
        if text:
            out.append(text)
    return out


def _clean_tasks(raw: object) -> list[dict[str, str]]:
    if not isinstance(raw, list):
        return []
    out: list[dict[str, str]] = []
    for item in raw[:MAX_ITEMS]:
        if not isinstance(item, dict):
            continue
        task = str(item.get("task") or "").strip()[:MAX_ITEM]
        if not task:
            continue
        out.append(
            {
                "task": task,
                "owner": str(item.get("owner") or "").strip()[:120],
                "due": str(item.get("due") or "").strip()[:120],
            }
        )
    return out


@dataclass
class WorkspaceState:
    title: str = ""
    plan: list[str] = field(default_factory=list)
    decisions: list[str] = field(default_factory=list)
    tasks: list[dict[str, str]] = field(default_factory=list)
    notes: str = ""

    def snapshot(self) -> dict[str, Any]:
        return {
            "title": self.title,
            "plan": list(self.plan),
            "decisions": list(self.decisions),
            "tasks": [dict(t) for t in self.tasks],
            "notes": self.notes,
        }

    def empty(self) -> bool:
        return not (
            self.title or self.plan or self.decisions or self.tasks or self.notes.strip()
        )

    def apply(
        self,
        *,
        title: str | None = None,
        plan: list[str] | None = None,
        decisions: list[str] | None = None,
        tasks: list[dict[str, str]] | None = None,
        notes: str | None = None,
        merge: bool = True,
    ) -> None:
        if title is not None:
            self.title = title.strip()[:MAX_TITLE]
        if plan is not None:
            self.plan = _clean_list(plan) if not merge else _merge_unique(self.plan, plan)
        if decisions is not None:
            self.decisions = (
                _clean_list(decisions) if not merge else _merge_unique(self.decisions, decisions)
            )
        if tasks is not None:
            cleaned = _clean_tasks(tasks)
            self.tasks = cleaned if not merge else _merge_tasks(self.tasks, cleaned)
        if notes is not None:
            text = notes.strip()[:MAX_NOTES]
            if merge and self.notes and text:
                self.notes = f"{self.notes}\n{text}"[:MAX_NOTES]
            else:
                self.notes = text


def _merge_unique(current: list[str], incoming: object) -> list[str]:
    seen = {x.casefold() for x in current}
    out = list(current)
    for item in _clean_list(incoming):
        key = item.casefold()
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
        if len(out) >= MAX_ITEMS:
            break
    return out


def _merge_tasks(
    current: list[dict[str, str]], incoming: list[dict[str, str]]
) -> list[dict[str, str]]:
    seen = {t["task"].casefold() for t in current}
    out = [dict(t) for t in current]
    for task in incoming:
        key = task["task"].casefold()
        if key in seen:
            continue
        seen.add(key)
        out.append(task)
        if len(out) >= MAX_ITEMS:
            break
    return out


class Host(Protocol):
    def actions_allowed(self) -> bool: ...


class Workspace:
    """The meeting's shared work board, broadcast to the room."""

    def __init__(self, room: rtc.Room) -> None:
        self.room = room
        self.state = WorkspaceState()

    async def publish(self) -> None:
        try:
            await self.room.local_participant.send_text(
                json.dumps(self.state.snapshot(), ensure_ascii=False),
                topic=WORKSPACE_TOPIC,
            )
        except Exception:
            logger.warning("could not publish the workspace", exc_info=True)

    async def update(
        self,
        *,
        title: str | None = None,
        plan: list[str] | None = None,
        decisions: list[str] | None = None,
        tasks: list[dict[str, str]] | None = None,
        notes: str | None = None,
        replace: bool = False,
    ) -> dict[str, Any]:
        self.state.apply(
            title=title,
            plan=plan,
            decisions=decisions,
            tasks=tasks,
            notes=notes,
            merge=not replace,
        )
        await self.publish()
        return self.state.snapshot()

    async def clear(self) -> dict[str, Any]:
        self.state = WorkspaceState()
        await self.publish()
        return self.state.snapshot()


ACTIONS_OFF = "As ações da IA estão desligadas nesta sala. Explique com educação."


def workspace_tools(board: Workspace, host: Host) -> list[llm.FunctionTool[..., Any]]:
    @llm.function_tool(name="atualizar_workspace")
    async def update_workspace(
        titulo: str = "",
        plano: list[str] | None = None,
        decisoes: list[str] | None = None,
        tarefas: list[dict[str, str]] | None = None,
        notas: str = "",
        substituir: bool = False,
    ) -> str:
        """Atualiza o quadro de trabalho compartilhado da reunião (todos veem).

        Args:
            titulo: título curto do quadro (ex.: plano do evento).
            plano: passos ou cronograma.
            decisoes: decisões tomadas.
            tarefas: lista de {task, owner, due}.
            notas: texto livre curto.
            substituir: se true, troca o conteúdo em vez de acrescentar.
        """
        if not host.actions_allowed():
            return ACTIONS_OFF
        snap = await board.update(
            title=titulo or None,
            plan=plano,
            decisions=decisoes,
            tasks=tarefas,
            notes=notas or None,
            replace=substituir,
        )
        parts = []
        if snap["title"]:
            parts.append(f"título «{snap['title']}»")
        if snap["plan"]:
            parts.append(f"{len(snap['plan'])} itens no plano")
        if snap["decisions"]:
            parts.append(f"{len(snap['decisions'])} decisões")
        if snap["tasks"]:
            parts.append(f"{len(snap['tasks'])} tarefas")
        if snap["notes"]:
            parts.append("notas")
        return "Quadro atualizado: " + (", ".join(parts) if parts else "vazio") + "."

    @llm.function_tool(name="limpar_workspace")
    async def clear_workspace() -> str:
        """Apaga o quadro de trabalho compartilhado e começa do zero."""
        if not host.actions_allowed():
            return ACTIONS_OFF
        await board.clear()
        return "Quadro de trabalho limpo."

    return [update_workspace, clear_workspace]
