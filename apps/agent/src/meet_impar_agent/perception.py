"""What the agent may look at in the meeting, when someone asks: the whiteboard, the polls and
the screens people share.

The board and the polls reach the agent the same way they reach every browser (LiveKit text
streams) and the same rules apply: drawings from people who may not draw are ignored and a vote
counts once per person. Screens are looked at only when asked, one frame at a time. Nothing is
stored: the board and polls live in memory for the meeting, and a screen image only goes into
the conversation until the next one replaces it.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

from livekit import rtc
from livekit.agents import llm
from livekit.agents.utils import images

from . import board_present
from .moderation import find

logger = logging.getLogger("meet_impar_agent.perception")

BOARD_TOPIC = "impa-whiteboard"
POLLS_TOPIC = "impa-polls"
POLICY_TOPIC = "impa.policy"
MAX_MESSAGE_CHARS = 2_000_000
MAX_ELEMENTS = 2000
MAX_DESCRIBED = 60
MAX_DESCRIPTION = 3500
MAX_POLLS = 50
FRAME_TIMEOUT_S = 6.0
SUBSCRIBE_TIMEOUT_S = 5.0

ACTIONS_OFF = (
    "Os moderadores desligaram as ações da IA nesta sala: você não pode olhar o quadro, as "
    "enquetes nem as telas agora. Explique isso com educação."
)

ACTIONS_OFF_PRESENT = (
    "Os moderadores desligaram as ações da IA nesta sala: você não pode escrever no quadro "
    "agora. Explique isso com educação e diga os tópicos em voz."
)

TYPE_NAMES = {
    "rectangle": "retângulo",
    "ellipse": "elipse",
    "diamond": "losango",
    "arrow": "seta",
    "line": "linha",
    "freedraw": "desenho à mão livre",
    "text": "texto",
    "image": "imagem",
    "frame": "moldura",
    "magicframe": "moldura",
    "embeddable": "conteúdo incorporado",
    "iframe": "conteúdo incorporado",
}


def _json(raw: str) -> dict[str, Any] | None:
    if len(raw) > MAX_MESSAGE_CHARS:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def _number(value: object) -> float:
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else 0.0


def _is_element(e: object) -> bool:
    if not isinstance(e, dict):
        return False
    eid, version, nonce = e.get("id"), e.get("version"), e.get("versionNonce")
    return (
        isinstance(eid, str)
        and 0 < len(eid) <= 100  # noqa: PLR2004
        and isinstance(version, int)
        and isinstance(nonce, int)
    )


@dataclass
class Board:
    """The shared drawing, merged the way Excalidraw does (highest version, then lowest nonce)."""

    policy: str = "everyone"
    elements: dict[str, dict[str, Any]] = field(default_factory=dict)
    order: list[str] = field(default_factory=list)
    authors: dict[str, str] = field(default_factory=dict)

    def may_draw(self, role: str) -> bool:
        return self.policy != "moderators" or role == "moderator"

    def apply(self, raw: str, sender_name: str, sender_role: str) -> bool:
        """Merges one message; True when the drawing changed."""
        data = _json(raw)
        if not data or data.get("type") != "scene" or not self.may_draw(sender_role):
            return False
        incoming = data.get("elements")
        if not isinstance(incoming, list) or not all(_is_element(e) for e in incoming):
            return False
        changed = False
        for e in incoming:
            current = self.elements.get(e["id"])
            wins = current is None or (
                e["version"] > current["version"]
                if e["version"] != current["version"]
                else e["versionNonce"] < current["versionNonce"]
            )
            if not wins:
                continue
            if current is None:
                if len(self.order) >= MAX_ELEMENTS:
                    continue
                self.order.append(e["id"])
            self.elements[e["id"]] = e
            self.authors[e["id"]] = sender_name
            changed = True
        return changed

    def put(self, elements: list[dict[str, Any]], author: str) -> None:
        """What this agent itself sent (LiveKit does not echo it back)."""
        for e in elements:
            if e["id"] not in self.elements:
                self.order.append(e["id"])
            self.elements[e["id"]] = e
            self.authors[e["id"]] = author

    def all(self) -> list[dict[str, Any]]:
        return [self.elements[i] for i in self.order]

    def _live(self) -> list[dict[str, Any]]:
        return [self.elements[i] for i in self.order if not self.elements[i].get("isDeleted")]

    def describe(self) -> str:
        live = self._live()
        if not live:
            return "O quadro está vazio."
        labels: dict[str, str] = {}
        for e in live:
            container = e.get("containerId")
            if e.get("type") == "text" and isinstance(container, str):
                labels[container] = str(e.get("text") or "").strip()
        shown = [e for e in live if not (e.get("type") == "text" and e.get("containerId"))]
        xs = [_number(e.get("x")) for e in shown] + [
            _number(e.get("x")) + _number(e.get("width")) for e in shown
        ]
        ys = [_number(e.get("y")) for e in shown] + [
            _number(e.get("y")) + _number(e.get("height")) for e in shown
        ]
        left, right, top, bottom = min(xs), max(xs), min(ys), max(ys)

        def where(e: dict[str, Any]) -> str:
            cx = _number(e.get("x")) + _number(e.get("width")) / 2
            cy = _number(e.get("y")) + _number(e.get("height")) / 2
            col = _third(cx, left, right, ("à esquerda", "no centro", "à direita"))
            row = _third(cy, top, bottom, ("em cima", "no meio", "embaixo"))
            return "no centro" if (col, row) == ("no centro", "no meio") else f"{row}, {col}"

        def name(e: dict[str, Any]) -> str:
            text = (
                str(e.get("text") or "").strip()
                if e.get("type") == "text"
                else labels.get(str(e.get("id")), "")
            )
            kind = TYPE_NAMES.get(str(e.get("type")), "elemento")
            return f"{kind} “{text[:120]}”" if text else kind

        by_id = {str(e.get("id")): e for e in live}
        lines: list[str] = []
        for e in shown[:MAX_DESCRIBED]:
            line = name(e)
            if e.get("type") == "arrow":
                ends = [
                    by_id.get(str((e.get(k) or {}).get("elementId")))
                    for k in ("startBinding", "endBinding")
                ]
                if ends[0] is not None and ends[1] is not None:
                    line = f"{line} ligando {name(ends[0])} a {name(ends[1])}"
            if e.get("type") == "image" and not labels.get(str(e.get("id"))):
                line += " (sem descrição)"
            author = self.authors.get(str(e.get("id")))
            lines.append(f"- {line}, {where(e)}" + (f", por {author}" if author else ""))
        people = sorted(
            {self.authors[str(e.get("id"))] for e in shown if e.get("id") in self.authors}
        )
        head = f"O quadro tem {len(shown)} elemento{'s' if len(shown) != 1 else ''}"
        head += f" (feito por {', '.join(people)})." if people else "."
        more = len(shown) - MAX_DESCRIBED
        tail = f"\n… e mais {more}." if more > 0 else ""
        return (head + "\n" + "\n".join(lines) + tail)[:MAX_DESCRIPTION]


def _third(value: float, low: float, high: float, names: tuple[str, str, str]) -> str:
    if high - low < 1:
        return names[1]
    part = (value - low) / (high - low)
    return names[0] if part < 1 / 3 else names[2] if part > 2 / 3 else names[1]


def _text(value: object, limit: int) -> bool:
    return isinstance(value, str) and len(value.strip()) > 0 and len(value) <= limit


def _valid_poll(p: object) -> bool:
    if not isinstance(p, dict):
        return False
    options = p.get("options")
    return (
        _text(p.get("id"), 64)
        and _text(p.get("question"), 300)
        and isinstance(options, list)
        and 2 <= len(options) <= 6  # noqa: PLR2004
        and all(_text(o, 120) for o in options)
    )


@dataclass
class Polls:
    """The meeting's polls with the same rules as the browsers (sender identity from LiveKit)."""

    polls: list[dict[str, Any]] = field(default_factory=list)
    votes: dict[str, dict[str, int]] = field(default_factory=dict)

    def _poll(self, poll_id: object) -> dict[str, Any] | None:
        return next((p for p in self.polls if p["id"] == poll_id), None)

    def _add(self, p: dict[str, Any], by: str, closed: bool) -> None:
        if self._poll(p["id"]) is None:
            self.polls.append(
                {
                    "id": p["id"],
                    "question": p["question"],
                    "options": list(p["options"]),
                    "byName": str(p.get("byName") or "")[:80],
                    "by": by,
                    "closed": closed,
                }
            )
            self.polls = self.polls[-MAX_POLLS:]

    def apply(self, raw: str, sender: str) -> None:
        data = _json(raw)
        if not data:
            return
        kind = data.get("type")
        if kind == "poll" and _valid_poll(data.get("poll")):
            self._add(data["poll"], sender, closed=False)
        elif kind == "vote":
            poll, option = self._poll(data.get("pollId")), data.get("option")
            if (
                poll is not None
                and isinstance(option, int)
                and not poll["closed"]
                and 0 <= option < len(poll["options"])
            ):
                self.votes.setdefault(poll["id"], {})[sender] = option
        elif kind == "close":
            poll = self._poll(data.get("pollId"))
            if poll and poll["by"] == sender:
                poll["closed"] = True
        elif kind == "state" and isinstance(data.get("state"), dict):
            self._merge(data["state"])

    def _merge(self, state: dict[str, Any]) -> None:
        theirs = state.get("polls")
        for p in theirs if isinstance(theirs, list) else []:
            if not _valid_poll(p):
                continue
            mine = self._poll(p["id"])
            if mine is None:
                self._add(p, str(p.get("by") or ""), closed=p.get("closed") is True)
            elif p.get("closed") is True:
                mine["closed"] = True
        votes = state.get("votes")
        for poll_id, by_voter in (votes if isinstance(votes, dict) else {}).items():
            poll = self._poll(poll_id)
            if not poll or not isinstance(by_voter, dict):
                continue
            known = self.votes.setdefault(poll_id, {})
            for voter, option in by_voter.items():
                ok = isinstance(option, int) and 0 <= option < len(poll["options"])
                if ok and voter not in known:
                    known[voter] = option

    def describe(self) -> str:
        if not self.polls:
            return "Não há enquetes nesta reunião."
        out: list[str] = []
        for p in self.polls[-10:]:
            counts = [0] * len(p["options"])
            for option in self.votes.get(p["id"], {}).values():
                counts[option] += 1
            total = sum(counts)
            state = "encerrada" if p["closed"] else "aberta"
            by = f", criada por {p['byName']}" if p["byName"] else ""
            options = "; ".join(
                f"{o}: {n} voto{'s' if n != 1 else ''}"
                for o, n in zip(p["options"], counts, strict=True)
            )
            out.append(f"- “{p['question']}” ({state}{by}, {total} votos) → {options}")
        return "Enquetes (só a contagem; ninguém sabe em quem cada pessoa votou):\n" + "\n".join(
            out
        )


@dataclass(frozen=True)
class Sharer:
    name: str
    identity: str
    publication: Any


def sharers(room: rtc.Room) -> list[Sharer]:
    """People (never assistants) sharing their screen right now."""
    out: list[Sharer] = []
    for p in room.remote_participants.values():
        if p.kind == rtc.ParticipantKind.PARTICIPANT_KIND_AGENT:
            continue
        for pub in p.track_publications.values():
            if (
                pub.source == rtc.TrackSource.SOURCE_SCREENSHARE
                and pub.kind == rtc.TrackKind.KIND_VIDEO
            ):
                out.append(Sharer(name=p.name or p.identity, identity=p.identity, publication=pub))
    return out


async def grab_frame(publication: Any) -> str:
    """One frame of a shared screen, as base64 JPEG (subscribing just for it if needed)."""
    subscribed_here = publication.track is None
    if subscribed_here:
        publication.set_subscribed(True)
    try:
        async with asyncio.timeout(SUBSCRIBE_TIMEOUT_S):
            while publication.track is None:  # noqa: ASYNC110 - no per-publication event
                await asyncio.sleep(0.1)
        stream = rtc.VideoStream(publication.track)
        try:
            event = await asyncio.wait_for(anext(stream), FRAME_TIMEOUT_S)
        finally:
            await stream.aclose()
        jpeg = images.encode(
            event.frame,
            images.EncodeOptions(
                format="JPEG",
                quality=70,
                resize_options=images.ResizeOptions(
                    width=1280, height=720, strategy="scale_aspect_fit"
                ),
            ),
        )
        return base64.b64encode(jpeg).decode("ascii")
    finally:
        if subscribed_here:
            with contextlib.suppress(Exception):
                publication.set_subscribed(False)


class Host(Protocol):
    """The parts of the agent the perception tools need."""

    def actions_allowed(self) -> bool: ...

    async def show_image(self, label: str, image_b64: str) -> None: ...


Grab = Callable[[Any], Any]


@dataclass
class Perception:
    """What this agent may look at in this room, kept up to date while the meeting runs."""

    room: rtc.Room
    allowed: tuple[str, ...]
    board: Board = field(default_factory=Board)
    polls: Polls = field(default_factory=Polls)
    grab: Grab = grab_frame
    # The agent's name, shown as the author of what it writes on the board.
    author: str = "IA"

    def _who(self, identity: str) -> tuple[str, str]:
        p = self.room.remote_participants.get(identity)
        if p is None:
            return identity, "participant"
        return p.name or identity, (p.attributes or {}).get("role", "participant")

    def on_board(self, raw: str, identity: str) -> None:
        # Presenting needs the board too: to place the topics beside what is drawn.
        if "board" in self.allowed or "present" in self.allowed:
            name, role = self._who(identity)
            self.board.apply(raw, name, role)

    async def _send_board(self, elements: list[dict[str, Any]]) -> None:
        self.board.put(elements, self.author)
        message = json.dumps({"type": "scene", "elements": elements}, ensure_ascii=False)
        await self.room.local_participant.send_text(message, topic=BOARD_TOPIC)

    async def present(self, title: str, topics: list[str]) -> bool:
        """Writes title and topics on the board, replacing this agent's previous presentation."""
        title, topics = board_present.clean(title, topics)
        if not title or not topics:
            return False
        await self._send_board(
            board_present.presentation(title, topics, self.board.all(), self.author)
        )
        return True

    async def clear_presentation(self) -> bool:
        """Removes what this agent wrote; nothing anybody else drew."""
        retired = board_present.retire(self.board.all())
        if retired:
            await self._send_board(retired)
        return bool(retired)

    def on_polls(self, raw: str, identity: str) -> None:
        if "polls" in self.allowed:
            self.polls.apply(raw, identity)

    def on_policy(self, raw: bytes) -> None:
        data = _json(raw.decode("utf-8", errors="replace"))
        if data and data.get("board") in ("everyone", "moderators"):
            self.board.policy = data["board"]


PRESENT_NOTE = (
    "APRESENTAR NO QUADRO: para mostrar um resumo, passos ou uma explicação em tópicos, use "
    "apresentar_no_quadro. Os tópicos ficam escritos no quadro branco da reunião, que todos "
    "conseguem ler, inclusive quem usa leitor de tela, e aparecem como seus. Prefira isso a "
    "mostrar tópicos na tela compartilhada. Uma nova apresentação substitui a anterior; use "
    "limpar_apresentacao_do_quadro quando terminar ou quando pedirem. Você nunca apaga nem "
    "muda o que as pessoas desenharam. Sempre diga em voz o que apresentou."
)


def perception_note(allowed: tuple[str, ...]) -> str:
    can = {
        "board": "o quadro branco (ver_quadro)",
        "polls": "as enquetes (ver_enquetes)",
        "screen": "a tela que alguém está compartilhando (ver_tela_compartilhada)",
    }
    seen = [a for a in allowed if a in can]
    parts = []
    if seen:
        parts.append(
            "VER A REUNIÃO: quando pedirem, você pode olhar "
            + "; ".join(can[a] for a in seen)
            + ". Só olhe quando alguém pedir. Ao descrever, diga de quem é o conteúdo (quem "
            "desenhou ou quem está compartilhando) e fale de forma curta e clara, pensando em "
            "quem não está vendo a tela. Nunca diga em quem uma pessoa votou."
        )
    if "present" in allowed:
        parts.append(PRESENT_NOTE)
    return "\n\n".join(parts)


def perception_tools(view: Perception, host: Host) -> list[llm.FunctionTool[..., Any]]:
    tools: list[llm.FunctionTool[..., Any]] = []

    if "board" in view.allowed:

        @llm.function_tool(name="ver_quadro")
        async def see_board() -> str:
            """Descreve o que está no quadro branco agora: formas, textos, setas e quem fez."""
            return view.board.describe() if host.actions_allowed() else ACTIONS_OFF

        tools.append(see_board)

    if "polls" in view.allowed:

        @llm.function_tool(name="ver_enquetes")
        async def see_polls() -> str:
            """Mostra as enquetes da reunião e quantos votos cada opção tem."""
            return view.polls.describe() if host.actions_allowed() else ACTIONS_OFF

        tools.append(see_polls)

    if "screen" in view.allowed:

        @llm.function_tool(name="ver_tela_compartilhada")
        async def see_screen(pessoa: str = "") -> str:
            """Olha a tela que alguém está compartilhando agora.

            Args:
                pessoa: de quem é a tela, quando mais de uma pessoa compartilha (opcional).
            """
            if not host.actions_allowed():
                return ACTIONS_OFF
            options = sharers(view.room)
            if not options:
                return "Ninguém está compartilhando a tela agora."
            chosen = find(pessoa, options) if pessoa.strip() else options
            if not chosen:
                names = ", ".join(s.name for s in options)
                return f"{pessoa} não está compartilhando. Estão compartilhando: {names}."
            if len(chosen) > 1:
                names = ", ".join(s.name for s in chosen)
                return f"Mais de uma pessoa compartilha a tela: {names}. Pergunte de quem."
            sharer = chosen[0]
            try:
                image = await view.grab(sharer.publication)
            except (TimeoutError, RuntimeError, OSError, ValueError) as exc:
                logger.warning(
                    "could not grab the shared screen", extra={"error": type(exc).__name__}
                )
                return f"Não consegui ver a tela de {sharer.name} agora. Tente de novo."
            await host.show_image(f"[Tela compartilhada por {sharer.name}, agora]", image)
            return (
                f"A imagem da tela de {sharer.name} está na conversa. Descreva o que vê em poucas "
                f"frases, dizendo que é a tela de {sharer.name}."
            )

        tools.append(see_screen)

    if "present" in view.allowed:

        @llm.function_tool(name="apresentar_no_quadro")
        async def present(titulo: str, topicos: list[str]) -> str:
            """Escreve no quadro branco da reunião um título e tópicos curtos, para todos.

            Args:
                titulo: Título da apresentação.
                topicos: De um a oito tópicos curtos, na ordem em que você vai falar.
            """
            if not host.actions_allowed():
                return ACTIONS_OFF_PRESENT
            if not await view.present(titulo, topicos):
                return "Informe um título e pelo menos um tópico."
            return (
                "Os tópicos estão no quadro branco, em texto que todos conseguem ler: "
                + board_present.outline(titulo, topicos).replace("\n", " ")
                + ". Diga em voz o que apresentou e sugira abrir o quadro para acompanhar."
            )

        @llm.function_tool(name="limpar_apresentacao_do_quadro")
        async def clear() -> str:
            """Tira do quadro branco a sua apresentação (o que as pessoas desenharam fica)."""
            if not host.actions_allowed():
                return ACTIONS_OFF_PRESENT
            if await view.clear_presentation():
                return "Tirei a sua apresentação do quadro."
            return "Não há apresentação sua no quadro."

        tools += [present, clear]

    return tools
