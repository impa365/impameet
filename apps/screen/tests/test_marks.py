from __future__ import annotations

from meet_impar_screen.marks import (
    LAYER_ID,
    MARK_ATTRIBUTE,
    MARK_JS,
    MAX_MARKS,
    Mark,
    parse_marks,
    percent_to_viewport,
)


def test_parse_marks_keeps_valid_entries_only() -> None:
    raw = [
        {"n": 1, "kind": "ícone", "label": "", "x": 10.4, "y": 20.6, "w": 24, "h": 24},
        {"n": "2", "kind": "link", "label": "x" * 200, "x": 0, "y": 0, "w": 50, "h": 10},
        {"n": 3, "x": 0, "y": 0},  # no size
        "not a mark",
        {"n": "três", "x": 0, "y": 0, "w": 1, "h": 1},
    ]
    marks = parse_marks(raw)
    assert [m.n for m in marks] == [1, 2]
    assert marks[0] == Mark(1, "ícone", "", 10.4, 20.6, 24.0, 24.0)
    assert len(marks[1].label) == 60
    assert parse_marks({"n": 1}) == ()
    assert parse_marks(None) == ()


def test_parse_marks_is_bounded_and_defaults_the_kind() -> None:
    raw = [{"n": i, "x": 0, "y": 0, "w": 9, "h": 9} for i in range(1, 500)]
    marks = parse_marks(raw)
    assert len(marks) == MAX_MARKS
    assert marks[0].kind == "elemento"


def test_marks_json_is_compact() -> None:
    assert Mark(4, "gráfico", "Vendas", 10.4, 20.6, 300.2, 150.7).as_json() == {
        "n": 4,
        "kind": "gráfico",
        "label": "Vendas",
        "x": 10,
        "y": 21,
        "width": 300,
        "height": 151,
    }


def test_percent_positions_map_to_the_viewport_and_are_clamped() -> None:
    assert percent_to_viewport(50, 50, 1280, 720) == (640, 360)
    assert percent_to_viewport(0, 0, 1280, 720) == (0, 0)
    assert percent_to_viewport(100, 100, 1280, 720) == (1279, 719)
    assert percent_to_viewport(-20, 250, 1280, 720) == (0, 719)


def test_the_page_script_uses_the_shared_names() -> None:
    assert "__ATTR__" not in MARK_JS
    assert "__LAYER__" not in MARK_JS
    assert MARK_ATTRIBUTE in MARK_JS
    assert LAYER_ID in MARK_JS
