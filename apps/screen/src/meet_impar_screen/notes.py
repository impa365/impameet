"""A clean, readable "slide" with the topics the agent wants to show."""

from __future__ import annotations

from dataclasses import dataclass
from html import escape

MAX_TITLE = 120
MAX_POINTS = 8
MAX_POINT = 240

_PAGE = """<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><style>
html,body{{margin:0;height:100%;background:#16181d;color:#f2f2f2;
font-family:Inter,'Segoe UI',Roboto,'Noto Sans',system-ui,sans-serif}}
main{{box-sizing:border-box;height:100%;padding:64px 88px;display:flex;flex-direction:column}}
small{{color:#8fb4ff;letter-spacing:.12em;text-transform:uppercase;font-size:18px}}
h1{{font-size:52px;line-height:1.15;margin:14px 0 36px}}
ul{{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:20px}}
li{{font-size:32px;line-height:1.3;padding-left:40px;position:relative}}
li:before{{content:'';position:absolute;left:0;top:14px;width:16px;height:16px;
border-radius:50%;background:#246fe5}}
</style></head><body><main><small>{presenter}</small><h1>{title}</h1><ul>{items}</ul>
</main></body></html>"""


@dataclass(frozen=True)
class Notes:
    title: str
    points: tuple[str, ...]

    @classmethod
    def create(cls, title: str, points: list[str]) -> Notes:
        title = title.strip()[:MAX_TITLE]
        cleaned = tuple(p.strip()[:MAX_POINT] for p in points if p.strip())[:MAX_POINTS]
        if not title and not cleaned:
            raise ValueError("nada para mostrar")
        return cls(title=title, points=cleaned)


def render(notes: Notes, presenter: str) -> str:
    """Every piece of text is HTML-escaped: the content comes from the model."""
    items = "".join(f"<li>{escape(p)}</li>" for p in notes.points)
    return _PAGE.format(presenter=escape(presenter), title=escape(notes.title), items=items)
