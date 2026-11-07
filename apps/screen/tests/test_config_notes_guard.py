from __future__ import annotations

from pathlib import Path

import pytest

from meet_impar_screen.config import ConfigError, load_settings, read_secret
from meet_impar_screen.notes import MAX_POINT, MAX_POINTS, MAX_TITLE, Notes, render
from meet_impar_screen.urlguard import BlockedURLError, UrlGuard, is_public_ip

BASE = {
    "LIVEKIT_URL": "wss://lk.example.com",
    "LIVEKIT_API_KEY": "key",
    "LIVEKIT_API_SECRET": "secret-secret-secret",
    "SCREEN_TOKEN": "screen-token",
}


class TestConfig:
    def test_defaults_and_overrides(self) -> None:
        s = load_settings(BASE)
        assert (s.port, s.width, s.height, s.max_sessions) == (8090, 1280, 720, 4)
        s = load_settings({**BASE, "SCREEN_WIDTH": "1920", "SCREEN_DISPLAY_NAME": "Tela"})
        assert (s.width, s.display_name) == (1920, "Tela")
        assert "screen-token" in s.secret_values()
        assert "screen-token" not in repr(s)

    def test_secret_files(self, tmp_path: Path) -> None:
        f = tmp_path / "t"
        f.write_text("from-file\n")
        assert read_secret({"X_FILE": str(f)}, "X").get_secret_value() == "from-file"
        f.write_bytes(b"x" * 9000)
        with pytest.raises(ConfigError, match="larger"):
            read_secret({"X_FILE": str(f)}, "X")
        with pytest.raises(ConfigError, match="unreadable"):
            read_secret({"X_FILE": str(tmp_path / "missing")}, "X")
        with pytest.raises(ConfigError, match="missing secret"):
            read_secret({}, "X")

    def test_invalid_values_name_the_field_only(self) -> None:
        with pytest.raises(ConfigError, match="livekit_url") as err:
            load_settings({**BASE, "LIVEKIT_URL": "http://nope"})
        assert "secret" not in str(err.value)
        with pytest.raises(ConfigError, match="width"):
            load_settings({**BASE, "SCREEN_WIDTH": "99999"})


class TestNotes:
    def test_trims_and_limits(self) -> None:
        notes = Notes.create(" T " + "x" * 500, [" a ", "", "b" * 999, *["c"] * 20])
        assert len(notes.title) == MAX_TITLE
        assert notes.points[0] == "a"
        assert len(notes.points[1]) == MAX_POINT
        assert len(notes.points) == MAX_POINTS

    def test_requires_content(self) -> None:
        with pytest.raises(ValueError, match="nada"):
            Notes.create("  ", ["  "])

    def test_escapes_model_text(self) -> None:
        html = render(Notes.create("<script>x</script>", ["a & b", "<img onerror=1>"]), "K<i>")
        assert "<script>x" not in html
        assert "&lt;script&gt;" in html
        assert "a &amp; b" in html
        assert "&lt;img onerror=1&gt;" in html
        assert "K&lt;i&gt;" in html


def resolver(table: dict[str, list[str]], calls: list[str] | None = None):  # type: ignore[no-untyped-def]
    async def resolve(host: str) -> list[str]:
        if calls is not None:
            calls.append(host)
        if host not in table:
            raise OSError("nxdomain")
        return table[host]

    return resolve


class TestUrlGuard:
    @pytest.mark.parametrize(
        ("ip", "public"),
        [
            ("8.8.8.8", True),
            ("2606:4700::1111", True),
            ("127.0.0.1", False),
            ("10.0.0.5", False),
            ("172.18.0.1", False),
            ("192.168.1.1", False),
            ("169.254.169.254", False),
            ("100.64.0.8", False),
            ("::1", False),
            ("fd00::1", False),
            ("::ffff:10.0.0.1", False),
            ("::ffff:8.8.8.8", True),
            ("224.0.0.1", False),
            ("fe80::1%eth0", False),
            ("not-an-ip", False),
        ],
    )
    def test_public_ips(self, ip: str, public: bool) -> None:
        assert is_public_ip(ip) is public

    async def test_allows_public_hosts_and_literals(self) -> None:
        guard = UrlGuard(resolver({"example.com": ["93.184.215.14"]}))
        assert await guard.check(" https://example.com/a?b=1 ") == "https://example.com/a?b=1"
        assert await guard.check("http://8.8.8.8:8080/") == "http://8.8.8.8:8080/"

    @pytest.mark.parametrize(
        "url",
        [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "ftp://example.com/",
            "https://",
            "https://user:pw@example.com/",
            "http://127.0.0.1/",
            "http://[::1]/",
            "http://169.254.169.254/latest/meta-data",
            "http://platform:3000/api/internal/agents/x",
            "http://internal.example/",
            "http://mixed.example/",
            "http://nxdomain.example/",
            "http://example.com:99999/",
            "https://example.com/" + "a" * 3000,
        ],
    )
    async def test_blocks(self, url: str) -> None:
        guard = UrlGuard(
            resolver(
                {
                    "example.com": ["93.184.215.14"],
                    "platform": ["10.231.0.7"],
                    "internal.example": ["192.168.0.10"],
                    "mixed.example": ["93.184.215.14", "10.0.0.1"],
                }
            )
        )
        with pytest.raises(BlockedURLError):
            await guard.check(url)
        assert await guard.allows(url) is False

    async def test_caches_dns_answers(self) -> None:
        calls: list[str] = []
        guard = UrlGuard(resolver({"example.com": ["93.184.215.14"]}, calls))
        for _ in range(3):
            assert await guard.allows("https://example.com/x")
        assert calls == ["example.com"]
        expiring = UrlGuard(resolver({"example.com": ["93.184.215.14"]}, calls), ttl_s=0)
        await expiring.allows("https://example.com/")
        await expiring.allows("https://example.com/")
        assert calls == ["example.com"] * 3

    async def test_system_resolver(self) -> None:
        assert await UrlGuard().allows("http://localhost/") is False
