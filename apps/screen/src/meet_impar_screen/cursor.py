"""A visible mouse cursor for the AI, drawn inside the shared page so the whole room sees it.

The cursor follows the browser's real mouse events, so gliding it over the page also triggers
hover menus and effects, exactly like a person moving a mouse.
"""

from __future__ import annotations

import asyncio
import math
from collections.abc import Awaitable, Callable

GLIDE_S = 0.6
GLIDE_STEPS = 24
POINT_HOLD_S = 2.5
SMOOTH_SCROLL_S = 0.7

# Brings an element near the edge (or off screen) to the middle with a smooth scroll, so the
# room can follow it; returns whether it scrolled.
CENTER_IF_NEAR_EDGE_JS = """(el) => {
  const r = el.getBoundingClientRect();
  const margin = innerHeight * 0.15;
  if (r.top >= margin && r.bottom <= innerHeight - margin) return false;
  el.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'smooth'});
  return true;
}"""

# Installed (idempotently) before every cursor action: pages and SPAs may replace the DOM.
INSTALL_JS = """() => {
  const ID = '__impa_ai_cursor';
  // document.open() (used by set_content) keeps the document but drops its listeners, so the
  // listener is re-added every time; the same function reference is never added twice.
  window.__impaCursorMove = window.__impaCursorMove || ((e) => {
    const el = document.getElementById(ID);
    if (el) el.style.transform = `translate(${e.clientX - 2}px, ${e.clientY - 2}px)`;
  });
  document.addEventListener('mousemove', window.__impaCursorMove, true);
  let root = document.getElementById(ID);
  if (root && root.isConnected) return;
  root = document.createElement('div');
  root.id = ID;
  root.setAttribute('aria-hidden', 'true');
  root.style.cssText = 'position:fixed;left:0;top:0;width:30px;height:38px;z-index:2147483647;'
    + 'pointer-events:none;transform:translate(-100px,-100px);transition:transform 40ms linear;';
  root.innerHTML = '<svg width="30" height="38" viewBox="0 0 30 38">'
    + '<path d="M2 2 L2 30 L9 23 L14 35 L19 33 L14 21 L24 21 Z" fill="#111" stroke="#fff" '
    + 'stroke-width="2.5" stroke-linejoin="round"/></svg>'
    + '<span style="position:absolute;left:20px;top:28px;padding:1px 6px;border-radius:8px;'
    + 'background:#246fe5;color:#fff;font:600 11px system-ui,sans-serif">IA</span>';
  document.documentElement.appendChild(root);
}"""

RIPPLE_JS = """([x, y]) => {
  const dot = document.createElement('div');
  dot.style.cssText = `position:fixed;left:${x - 18}px;top:${y - 18}px;width:36px;height:36px;`
    + 'border-radius:50%;border:3px solid #246fe5;z-index:2147483646;pointer-events:none;'
    + 'transition:transform 450ms ease-out,opacity 450ms ease-out;transform:scale(.3);opacity:1';
  document.documentElement.appendChild(dot);
  requestAnimationFrame(() => { dot.style.transform = 'scale(1.6)'; dot.style.opacity = '0'; });
  setTimeout(() => dot.remove(), 600);
}"""

HIGHLIGHT_JS = """([x, y, w, h, ms]) => {
  const box = document.createElement('div');
  box.className = '__impa_ai_highlight';
  box.style.cssText = `position:fixed;left:${x - 6}px;top:${y - 6}px;width:${w + 12}px;`
    + `height:${h + 12}px;border:3px solid #246fe5;border-radius:10px;z-index:2147483646;`
    + 'pointer-events:none;box-shadow:0 0 0 4px rgba(36,111,229,.25),0 0 24px rgba(36,111,229,.5);'
    + 'transition:opacity 400ms ease;opacity:1';
  document.documentElement.appendChild(box);
  setTimeout(() => { box.style.opacity = '0'; }, ms);
  setTimeout(() => box.remove(), ms + 500);
}"""


def ease_in_out(t: float) -> float:
    return 0.5 - math.cos(math.pi * max(0.0, min(1.0, t))) / 2


def glide_path(
    start: tuple[float, float], end: tuple[float, float], steps: int = GLIDE_STEPS
) -> list[tuple[float, float]]:
    """Points from start to end with a natural acceleration and a slight arc."""
    (x0, y0), (x1, y1) = start, end
    dx, dy = x1 - x0, y1 - y0
    bend = min(60.0, math.hypot(dx, dy) * 0.12)
    nx, ny = (-dy, dx) if (dx or dy) else (0.0, 0.0)
    norm = math.hypot(nx, ny) or 1.0
    points = []
    for i in range(1, steps + 1):
        t = ease_in_out(i / steps)
        arc = math.sin(math.pi * t) * bend
        points.append((x0 + dx * t + nx / norm * arc, y0 + dy * t + ny / norm * arc))
    return points


async def glide(
    move: Callable[[float, float], Awaitable[None]],
    start: tuple[float, float],
    end: tuple[float, float],
    *,
    duration_s: float = GLIDE_S,
    steps: int = GLIDE_STEPS,
) -> tuple[float, float]:
    for x, y in glide_path(start, end, steps):
        await move(x, y)
        await asyncio.sleep(duration_s / steps)
    return end
