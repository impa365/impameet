from __future__ import annotations

import math

import pytest

from meet_impar_screen.cursor import ease_in_out, glide, glide_path


def test_easing_starts_slow_and_stays_in_range() -> None:
    assert ease_in_out(0) == 0
    assert ease_in_out(1) == pytest.approx(1)
    assert ease_in_out(0.5) == pytest.approx(0.5)
    assert ease_in_out(-1) == 0
    assert ease_in_out(2) == pytest.approx(1)
    assert ease_in_out(0.1) < 0.1


def test_glide_path_arrives_exactly_with_a_gentle_arc() -> None:
    path = glide_path((0, 0), (400, 0), steps=20)
    assert len(path) == 20
    assert path[-1] == pytest.approx((400, 0))
    xs = [p[0] for p in path]
    assert xs == sorted(xs)
    mid = path[9]
    assert 0 < abs(mid[1]) <= 60  # bends a little, like a hand would
    long = glide_path((0, 0), (2000, 0), steps=20)
    assert max(abs(y) for _, y in long) == pytest.approx(60, abs=1)


def test_glide_path_in_place() -> None:
    assert glide_path((5, 5), (5, 5), steps=3) == [(5, 5)] * 3


async def test_glide_moves_through_every_point() -> None:
    seen: list[tuple[float, float]] = []

    async def move(x: float, y: float) -> None:
        seen.append((x, y))

    end = await glide(move, (0, 0), (30, 40), duration_s=0, steps=5)
    assert end == (30, 40)
    assert len(seen) == 5
    assert math.dist(seen[-1], (30, 40)) < 1e-9
