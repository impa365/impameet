"""Talks to a local fake OpenAI-compatible server over real HTTP streaming."""

from __future__ import annotations

import json
import threading
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest
from livekit.agents import APIConnectionError, APIStatusError
from livekit.agents import llm as lk_llm

from meet_impar_agent.config import LLMSettings
from meet_impar_agent.pipeline import build_conn_options, build_llm


@dataclass
class FakeLLMServer:
    delay_s: float = 0.0
    status: int = 200
    words: list[str] = field(default_factory=lambda: ["Olá", ", tudo", " bem?"])
    requests: list[dict[str, Any]] = field(default_factory=list)
    url: str = ""


class _QuietServer(ThreadingHTTPServer):
    daemon_threads = False
    block_on_close = True

    def handle_error(self, request: Any, client_address: Any) -> None:
        """Clients that gave up (timeouts under test) close the socket; that is expected."""


@pytest.fixture
def server() -> Iterator[FakeLLMServer]:
    state = FakeLLMServer()
    stopping = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: Any) -> None:
            pass

        def do_POST(self) -> None:
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            state.requests.append({"body": body, "auth": self.headers.get("Authorization")})
            if stopping.wait(state.delay_s):
                return
            if state.status != 200:
                self.send_response(state.status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"error": {"message": "nope"}}')
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for word in state.words:
                chunk = {
                    "id": "c",
                    "object": "chat.completion.chunk",
                    "created": 0,
                    "model": body["model"],
                    "choices": [{"index": 0, "delta": {"content": word}, "finish_reason": None}],
                }
                self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
                self.wfile.flush()
            self.wfile.write(b"data: [DONE]\n\n")

    httpd = _QuietServer(("127.0.0.1", 0), Handler)
    state.url = f"http://127.0.0.1:{httpd.server_port}/v1"
    thread = threading.Thread(target=httpd.serve_forever)
    thread.start()
    yield state
    stopping.set()
    httpd.shutdown()
    httpd.server_close()  # joins handler threads (block_on_close)
    thread.join()


async def _ask(settings: LLMSettings, server: FakeLLMServer) -> str:
    model = build_llm(settings, model="m", base_url=server.url, api_key="llm-secret")
    ctx = lk_llm.ChatContext()
    ctx.add_message(role="user", content="oi")
    parts: list[str] = []
    try:
        async with model.chat(
            chat_ctx=ctx, conn_options=build_conn_options(settings).llm_conn_options
        ) as stream:
            async for chunk in stream:
                if chunk.delta and chunk.delta.content:
                    parts.append(chunk.delta.content)
    finally:
        await model.aclose()
    return "".join(parts)


def _settings(timeout_s: float = 2.0) -> LLMSettings:
    return LLMSettings(timeout_s=timeout_s)


async def test_streams_the_reply_and_sends_the_configured_request(server: FakeLLMServer) -> None:
    assert await _ask(_settings(), server) == "Olá, tudo bem?"

    request = server.requests[0]
    assert request["auth"] == "Bearer llm-secret"
    assert request["body"]["model"] == "m"
    assert request["body"]["stream"] is True
    assert request["body"]["max_completion_tokens"] == 400
    assert request["body"]["temperature"] == pytest.approx(0.6)


async def test_a_stalled_llm_is_cut_off_instead_of_hanging(server: FakeLLMServer) -> None:
    server.delay_s = 3.0
    started = time.monotonic()

    with pytest.raises(APIConnectionError):
        await _ask(_settings(timeout_s=0.5), server)

    assert time.monotonic() - started < 2.5
    assert len(server.requests) == 2


async def test_auth_errors_are_not_retried(server: FakeLLMServer) -> None:
    server.status = 401

    with pytest.raises(APIStatusError):
        await _ask(_settings(), server)

    assert len(server.requests) == 1
