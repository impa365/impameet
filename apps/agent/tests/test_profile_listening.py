from __future__ import annotations

import json
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from typing import Any

import pytest

from meet_impar_agent.config import ConfigError, load_settings
from meet_impar_agent.listening import Speaker, is_addressed, may_listen, next_linked
from meet_impar_agent.profile import (
    KNOWLEDGE_HEADER,
    agent_id_from_metadata,
    load_profile,
    profile_from_platform,
)

AGENT_ID = "11111111-2222-4333-8444-555555555555"
TOKEN = "platform-token-0123456789abcdef"


class TestListening:
    @pytest.mark.parametrize(
        ("role", "agent", "mode", "expected"),
        [
            ("guest", False, "everyone", True),
            ("guest", False, "members", False),
            ("participant", False, "members", True),
            ("moderator", False, "members", True),
            ("participant", False, "moderators", False),
            ("moderator", False, "moderators", True),
            ("moderator", True, "everyone", False),
        ],
    )
    def test_may_listen(self, role: str, agent: bool, mode: Any, expected: bool) -> None:
        assert may_listen(Speaker("x", role, agent), mode) is expected

    def test_next_linked_prefers_the_loudest_eligible_speaker(self) -> None:
        speakers = [Speaker("g", "guest", False), Speaker("m", "moderator", False)]
        assert next_linked(speakers, None, "everyone") == "g"
        assert next_linked(speakers, None, "moderators") == "m"
        assert next_linked(speakers, "m", "everyone") is None
        assert next_linked([], None, "everyone") is None

    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("Kaiser, qual o prazo?", True),
            ("ei kaiser me ajuda", True),
            ("KAISER!", True),
            ("o kaiserismo é outra coisa", False),
            ("vamos começar", False),
            # Speech-to-text slips heard in real meetings
            ("Kaísa, responde pra gente", True),
            ("Kaize, clica aí em pular o anúncio", True),
            ("Kaizen, quem é você?", True),
            ("Kaiserr me ouve", True),
            # ...but not ordinary words that merely look alike
            ("a casa caiu", False),
            ("pega a caixa", False),
            ("kaio chegou", False),
        ],
    )
    def test_is_addressed(self, text: str, expected: bool) -> None:
        assert is_addressed(text, "Kaiser") is expected

    def test_short_and_long_names_tolerate_different_slips(self) -> None:
        assert is_addressed("Lara, oi", "Laura")  # one letter in a five-letter name
        assert not is_addressed("Larissa, oi", "Laura")
        assert not is_addressed("Ane, oi", "Ana")  # three letters: exact only
        assert is_addressed("Ana, oi", "Ana")
        assert not is_addressed("Ana Paulo", "Ana Paula")  # full names: the exact phrase
        assert is_addressed("ei Ana Paula", "Ana Paula")

    def test_is_addressed_ignores_accents(self) -> None:
        assert is_addressed("Olá, Júlia!", "Julia")
        assert is_addressed("Ola, Julia", "Júlia")
        assert is_addressed("qualquer coisa", "   ")


class TestMetadata:
    @pytest.mark.parametrize(
        ("metadata", "expected"),
        [
            (json.dumps({"agentId": AGENT_ID}), AGENT_ID),
            (json.dumps({"agentId": None}), None),
            (json.dumps({"agentId": "x" * 65}), None),
            (json.dumps(["not", "a", "dict"]), None),
            ("not json", None),
            ("", None),
            (None, None),
        ],
    )
    def test_agent_id(self, metadata: str | None, expected: str | None) -> None:
        assert agent_id_from_metadata(metadata) == expected


COMPLETE: dict[str, Any] = {
    "name": "Ana",
    "instructions": "Você é a Ana.",
    "llmModel": "qwen",
    "ttsModel": "drama-3",
    "sttModel": "transcribe-stream-1",
    "voices": {"pt": "voz-ana"},
    "llm": {"baseUrl": "https://llm.example/v1", "apiKey": "sk-0123456789"},
    "tts": {"provider": "fish", "apiKey": "fish-0123456789"},
    "stt": {"provider": "fish", "apiKey": "fish-0123456789"},
}


def test_profile_applies_platform_fields() -> None:
    merged = profile_from_platform(
        COMPLETE
        | {
            "knowledge": "  Plano Pro custa R$ 99.  ",
            "greeting": "Oi!",
            "listenMode": "moderators",
            "respondMode": "when_named",
        }
    )
    assert merged is not None
    assert merged.name == "Ana"
    assert merged.instructions == f"Você é a Ana.{KNOWLEDGE_HEADER}Plano Pro custa R$ 99."
    assert (merged.voice_id, merged.tts_model, merged.llm_model) == ("voz-ana", "drama-3", "qwen")
    assert (merged.listen_mode, merged.respond_mode) == ("moderators", "when_named")
    assert merged.greeting == "Oi!"


def test_profile_keeps_safe_behaviour_for_invalid_options() -> None:
    merged = profile_from_platform(COMPLETE | {"listenMode": "ninguem", "respondMode": 3})
    assert merged is not None
    assert (merged.listen_mode, merged.respond_mode) == ("everyone", "always")
    assert merged.greeting == ""


@pytest.fixture
def platform(env: dict[str, str], tmp_path: Path) -> Iterator[dict[str, Any]]:
    state: dict[str, Any] = {"status": 200, "body": {"agent": COMPLETE}, "headers": []}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: Any) -> None:
            pass

        def do_GET(self) -> None:
            state["headers"].append((self.path, self.headers.get("x-internal-token")))
            payload = (
                state["body"]
                if isinstance(state["body"], bytes)
                else json.dumps(state["body"]).encode()
            )
            self.send_response(state["status"])
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(payload)

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=httpd.serve_forever)
    thread.start()
    token_file = tmp_path / "platform_token"
    token_file.write_text(TOKEN)
    env |= {
        "PLATFORM_URL": f"http://127.0.0.1:{httpd.server_port}/",
        "PLATFORM_TOKEN_FILE": str(token_file),
    }
    state["settings"] = load_settings(env)
    yield state
    httpd.shutdown()
    httpd.server_close()
    thread.join()


async def test_load_profile_fetches_the_room_agent(platform: dict[str, Any]) -> None:
    profile = await load_profile(platform["settings"], json.dumps({"agentId": AGENT_ID}))
    assert profile is not None
    assert profile.name == "Ana"
    assert platform["headers"] == [(f"/api/internal/agents/{AGENT_ID}", TOKEN)]


@pytest.mark.parametrize(
    ("status", "body"),
    [(404, {"error": "not found"}), (200, b"not json"), (200, {"agent": "wrong"})],
)
async def test_load_profile_gives_nothing_when_the_lookup_fails(
    platform: dict[str, Any], status: int, body: Any
) -> None:
    platform["status"], platform["body"] = status, body
    assert await load_profile(platform["settings"], json.dumps({"agentId": AGENT_ID})) is None


async def test_load_profile_without_agent_or_platform(
    env: dict[str, str], platform: dict[str, Any]
) -> None:
    assert await load_profile(platform["settings"], None) is None
    plain = load_settings({k: v for k, v in env.items() if not k.startswith("PLATFORM_")})
    assert plain.platform is None
    assert await load_profile(plain, json.dumps({"agentId": AGENT_ID})) is None
    assert platform["headers"] == []


async def test_load_profile_survives_an_unreachable_platform(
    env: dict[str, str], tmp_path: Path
) -> None:
    token_file = tmp_path / "t"
    token_file.write_text(TOKEN)
    settings = load_settings(
        env | {"PLATFORM_URL": "http://127.0.0.1:1", "PLATFORM_TOKEN_FILE": str(token_file)}
    )
    assert await load_profile(settings, json.dumps({"agentId": AGENT_ID})) is None


def test_platform_url_requires_a_token(env: dict[str, str]) -> None:
    with pytest.raises(ConfigError, match="PLATFORM_TOKEN"):
        load_settings(env | {"PLATFORM_URL": "http://platform:3000"})


def test_platform_token_is_redacted(platform: dict[str, Any]) -> None:
    assert TOKEN in platform["settings"].secret_values()
