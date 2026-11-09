"""What the agent may do to other people in the meeting: remove, mute, answer the waiting room.

The platform carries out every action and enforces the hard limits: only the tools an admin
turned on, only when a moderator in the call asked or an admin rule applies, never on
moderators, the room owner, admins or other assistants, and everything goes to the audit log.
The agent adds two checks of its own: it finds people by the name it heard (asking when that
is ambiguous), and before removing someone at a moderator's request it asks out loud and waits
for that moderator's "yes".
"""

from __future__ import annotations

import functools
import logging
import time
import unicodedata
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass
from typing import Any, Protocol

import httpx
from livekit.agents import llm

from .config import PlatformSettings
from .languages import words
from .listening import same_name

logger = logging.getLogger("meet_impar_agent.moderation")

CONFIRM_WINDOW_S = 90.0
TIMEOUT_S = 5.0

AFFIRMATIVE = frozenset(
    {"sim", "pode", "confirmo", "confirma", "confirmado", "isso", "claro", "positivo", "manda"}
    | {"yes", "yeah", "yep", "sure", "ok", "okay", "si", "sí", "dale"}
)
NEGATIVE = frozenset({"não", "nao", "no", "nope", "cancela", "cancele", "espera", "deixa", "nem"})
EVERYONE = frozenset({"todos", "todas", "todo mundo", "everyone", "all", "todo el mundo"})

KNOCK_PROMPT = (
    "Alguém acabou de pedir para entrar pela sala de espera. Chame ver_participantes para "
    "saber quem é. Se uma regra do administrador disser o que fazer, faça e avise a reunião em "
    "uma frase curta; se não houver regra, avise os moderadores e pergunte se pode aprovar."
)


@dataclass(frozen=True)
class Person:
    identity: str
    name: str
    role: str
    mic_on: bool
    protected: bool


@dataclass(frozen=True)
class Waiting:
    id: str
    name: str


@dataclass(frozen=True)
class Heard:
    """The last finished sentence the agent heard, and from whom."""

    at: float
    text: str
    identity: str
    role: str


class Host(Protocol):
    """The parts of the agent the moderation tools need."""

    def current_speaker(self) -> Any: ...

    def last_heard(self) -> Heard | None: ...


def moderation_note(tools: Iterable[str], rules: str) -> str:
    """Instructions for an agent that may act on people."""
    tools = tuple(tools)
    if not tools:
        return ""
    can = {
        "remove": "remover participantes (remover_participante)",
        "mute": "silenciar o microfone de alguém (silenciar_participante)",
        "lobby": "aprovar ou recusar quem está na sala de espera (responder_sala_de_espera)",
    }
    note = (
        "MODERAÇÃO: você pode " + "; ".join(can[t] for t in tools) + ". Chame ver_participantes "
        "para saber os nomes exatos. Só aja quando um moderador pedir (o papel aparece entre "
        "parênteses) ou quando uma das regras do administrador abaixo se aplicar; nesse caso, "
        "copie a regra no campo regra. Antes de remover alguém a pedido de um moderador, pergunte "
        "em voz alta se ele confirma. Depois de agir, diga em uma frase o que fez. Nunca aja "
        "sobre moderadores, o dono da sala ou outros assistentes; se pedirem, explique que não "
        "pode. Se o nome for parecido com o de mais de uma pessoa, pergunte qual."
    )
    if rules:
        note += f"\n\nREGRAS DO ADMINISTRADOR (siga-as mesmo sem pedirem):\n{rules}"
    return note


class Named(Protocol):
    @property
    def name(self) -> str: ...


def find[T: Named](name: str, candidates: Iterable[T]) -> list[T]:
    """People whose name matches what was said: the whole name, else the first name, else part."""
    pool = list(candidates)
    wanted = _plain(name)
    if not wanted:
        return []
    exact = [c for c in pool if same_name(c.name, name)]
    if exact:
        return exact
    first = [c for c in pool if _plain(c.name).split(" ")[0] == wanted]
    if first:
        return first
    return [c for c in pool if wanted in _plain(c.name)]


def _plain(text: str) -> str:
    """Lowercase words without accents, so "Jose" finds "José"."""
    bare = unicodedata.normalize("NFKD", text)
    return " ".join(words("".join(ch for ch in bare if not unicodedata.combining(ch))))


class ModerationClient:
    """The platform's moderation API for this agent in this room (internal token)."""

    def __init__(
        self,
        platform: PlatformSettings,
        agent_id: str,
        room: str,
        *,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._base = f"{str(platform.url).rstrip('/')}/api/internal/agents/{agent_id}/moderation"
        self._headers = {"x-internal-token": platform.token.get_secret_value()}
        self._room = room
        self._client = client or httpx.AsyncClient(timeout=TIMEOUT_S)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def view(self) -> tuple[list[Person], list[Waiting]]:
        res = await self._client.get(self._base, params={"room": self._room}, headers=self._headers)
        res.raise_for_status()
        body = res.json()
        people = [
            Person(
                identity=str(p["identity"]),
                name=str(p["name"]),
                role=str(p.get("role") or "participant"),
                mic_on=bool(p.get("micOn")),
                protected=bool(p.get("protected")),
            )
            for p in body.get("people", [])
        ]
        lobby = [Waiting(id=str(w["id"]), name=str(w["name"])) for w in body.get("lobby", [])]
        return people, lobby

    async def act(
        self, action: str, target: str, *, requested_by: str | None, rule: str | None
    ) -> str:
        """The platform's answer, ready to tell the model (what happened, or why not)."""
        payload: dict[str, str] = {"room": self._room, "action": action, "target": target}
        if requested_by:
            payload["requestedBy"] = requested_by
        if rule:
            payload["rule"] = rule[:500]
        res = await self._client.post(self._base, json=payload, headers=self._headers)
        try:
            body = res.json()
        except ValueError:
            body = {}
        if res.is_success:
            return f"Feito: {body.get('done', 'ação concluída')}."
        message = (body.get("error") or {}).get("message") or f"erro {res.status_code}"
        return f"Não foi possível: {message}."


def affirmative(text: str) -> bool:
    tokens = set(words(text))
    return bool(tokens & AFFIRMATIVE) and not tokens & NEGATIVE


def moderation_tools(  # noqa: PLR0915 - one closure per tool keeps each one self-contained
    client: ModerationClient,
    host: Host,
    tools: Iterable[str],
    *,
    has_rules: bool,
    clock: Callable[[], float] = time.monotonic,
) -> list[llm.FunctionTool[..., Any]]:
    enabled = set(tools)
    pending: dict[str, tuple[float, str]] = {}  # identity -> (asked at, moderator identity)

    def moderator() -> str | None:
        who = host.current_speaker()
        if who is not None and who.role == "moderator" and who.identity:
            return str(who.identity)
        return None

    def authority(regra: str) -> tuple[str | None, str | None] | str:
        """(requested_by, rule), or the reason the agent may not act."""
        by = moderator()
        if by:
            return by, None
        if has_rules and regra.strip():
            return None, regra.strip()
        return (
            "Só posso fazer isso quando um moderador pede ou quando uma regra do administrador "
            "se aplica. Explique isso com educação."
        )

    async def person(pessoa: str) -> Person | str:
        people, _ = await client.view()
        matches = find(pessoa, people)
        if not matches:
            names = ", ".join(p.name for p in people) or "ninguém"
            return f"Não encontrei {pessoa} na reunião. Quem está na chamada: {names}."
        if len(matches) > 1:
            return (
                "Há mais de uma pessoa com esse nome: "
                + ", ".join(m.name for m in matches)
                + ". Pergunte qual."
            )
        if matches[0].protected:
            return (
                f"{matches[0].name} é moderador, dono da sala ou administrador: não posso agir "
                "sobre essa pessoa."
            )
        return matches[0]

    result: list[llm.FunctionTool[..., Any]] = []

    def safe(
        fn: Callable[..., Awaitable[str]],
    ) -> Callable[..., Awaitable[str]]:
        @functools.wraps(fn)
        async def wrapper(*args: Any, **kwargs: Any) -> str:
            try:
                return await fn(*args, **kwargs)
            except httpx.HTTPError as exc:
                logger.warning("moderation call failed", extra={"error": type(exc).__name__})
                return "Não consegui falar com o servidor da reunião agora; tente de novo."

        return wrapper

    @llm.function_tool(name="ver_participantes")
    async def see() -> str:
        """Lista quem está na reunião (com papel e microfone) e quem espera na sala de espera."""
        try:
            people, lobby = await client.view()
        except httpx.HTTPError:
            return "Não consegui ver a lista de participantes agora."
        lines = [
            f"- {p.name} ({p.role}, microfone {'ligado' if p.mic_on else 'desligado'})"
            + (" [protegido]" if p.protected else "")
            for p in people
        ]
        waiting = [f"- {w.name}" for w in lobby]
        text = "Na reunião:\n" + ("\n".join(lines) or "- ninguém")
        if "lobby" in enabled:
            text += "\nNa sala de espera:\n" + ("\n".join(waiting) or "- ninguém")
        return text

    result.append(see)

    if "remove" in enabled:

        @llm.function_tool(name="remover_participante")
        @safe
        async def remove(pessoa: str, regra: str = "") -> str:
            """Remove alguém da reunião.

            Args:
                pessoa: o nome da pessoa, como aparece em ver_participantes.
                regra: a regra do administrador aplicada, quando você age sem um moderador pedir.
            """
            allowed = authority(regra)
            if isinstance(allowed, str):
                return allowed
            by, rule = allowed
            target = await person(pessoa)
            if isinstance(target, str):
                return target
            if by:
                asked = pending.get(target.identity)
                if asked is not None and clock() - asked[0] > CONFIRM_WINDOW_S:
                    asked = None
                heard = host.last_heard()
                confirmed = (
                    asked is not None
                    and heard is not None
                    and heard.at > asked[0]
                    and heard.identity == asked[1]
                    and affirmative(heard.text)
                )
                if not confirmed:
                    # Someone else's "yes" does not take the request over from who asked.
                    if asked is None:
                        pending[target.identity] = (clock(), by)
                    return (
                        f"Antes de remover, pergunte em voz alta: 'Quer mesmo que eu remova "
                        f"{target.name} da chamada?'. Só chame remover_participante de novo "
                        "depois que esse moderador disser que sim."
                    )
                pending.pop(target.identity, None)
            return await client.act("remove", target.identity, requested_by=by, rule=rule)

        result.append(remove)

    if "mute" in enabled:

        @llm.function_tool(name="silenciar_participante")
        @safe
        async def mute(pessoa: str, regra: str = "") -> str:
            """Desliga o microfone de alguém (a pessoa pode ligar de novo).

            Args:
                pessoa: o nome da pessoa, como aparece em ver_participantes.
                regra: a regra do administrador aplicada, quando você age sem um moderador pedir.
            """
            allowed = authority(regra)
            if isinstance(allowed, str):
                return allowed
            by, rule = allowed
            target = await person(pessoa)
            if isinstance(target, str):
                return target
            return await client.act("mute", target.identity, requested_by=by, rule=rule)

        result.append(mute)

    if "lobby" in enabled:

        @llm.function_tool(name="responder_sala_de_espera")
        @safe
        async def lobby(pessoa: str, aprovar: bool, regra: str = "") -> str:
            """Aprova ou recusa quem pediu para entrar pela sala de espera.

            Args:
                pessoa: o nome de quem está esperando, ou "todos".
                aprovar: true para deixar entrar, false para recusar.
                regra: a regra do administrador aplicada, quando você age sem um moderador pedir.
            """
            allowed = authority(regra)
            if isinstance(allowed, str):
                return allowed
            by, rule = allowed
            _, waiting = await client.view()
            if not waiting:
                return "Não há ninguém na sala de espera."
            everyone = " ".join(words(pessoa)) in EVERYONE
            chosen = waiting if everyone else find(pessoa, waiting)
            if not chosen:
                return "Na sala de espera estão: " + ", ".join(w.name for w in waiting) + "."
            if len(chosen) > 1 and not everyone:
                return (
                    "Mais de uma pessoa com esse nome: "
                    + ", ".join(w.name for w in chosen)
                    + ". Pergunte qual."
                )
            action = "admit" if aprovar else "deny"
            answers = [await client.act(action, w.id, requested_by=by, rule=rule) for w in chosen]
            return " ".join(answers)

        result.append(lobby)

    return result
