"""The meeting's chat, read by the agent.

LiveKit's own text input only accepts messages from the one participant the agent is linked
to (the person it is listening to), and it interrupts the agent's speech before answering,
which fails while the agent is speaking. In a meeting everyone writes in the chat, so the
agent reads the whole room's chat itself and answers after it finishes its sentence.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from livekit import rtc

logger = logging.getLogger("meet_impar_agent.chat")

#: The topic LiveKit's chat components write on.
CHAT_TOPIC = "lk.chat"
MAX_CHAT_CHARS = 2000

CHAT_INSTRUCTIONS = (
    "Você também lê o chat da reunião. Mensagens escritas chegam no formato "
    "'Nome (papel) no chat: texto'. Quando alguém mandar um link no chat, você pode abri-lo "
    "na tela se tiver essa ferramenta. Nunca diga que não consegue ler o chat."
)

#: Receives the author's identity, display name, room role and the message.
ChatListener = Callable[[str, str, str, str], Awaitable[None]]


def follow_chat(room: rtc.Room, on_message: ChatListener) -> None:
    """Hands every chat message written by a person in the room to ``on_message``."""
    tasks: set[asyncio.Task[None]] = set()

    def on_chat(reader: rtc.TextStreamReader, sender: str) -> None:
        async def read() -> None:
            author = room.remote_participants.get(sender)
            if author is None or author.kind == rtc.ParticipantKind.PARTICIPANT_KIND_AGENT:
                return
            try:
                text = (await reader.read_all()).strip()[:MAX_CHAT_CHARS]
            except Exception:
                logger.warning("could not read a chat message")
                return
            if not text:
                return
            role = (author.attributes or {}).get("role", "participant")
            try:
                await on_message(author.identity, author.name or author.identity, role, text)
            except Exception:
                logger.warning("could not answer a chat message", exc_info=True)

        task: Any = asyncio.ensure_future(read())
        tasks.add(task)
        task.add_done_callback(tasks.discard)

    room.register_text_stream_handler(CHAT_TOPIC, on_chat)
