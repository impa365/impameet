"""Numbered marks over what is on screen, so the AI can point at things that have no text.

Before a capture for the AI, every interactive or visual element in the viewport (links,
buttons, fields, images, icons, charts) gets a numbered badge. The capture goes to the model
with the badges; the badges are removed right after, while the room's video is paused, so
people never see them. The element keeps a ``data-impa-mark`` attribute until the next
capture, which is how a number is resolved back to the element (even after scrolling).
"""

from __future__ import annotations

from dataclasses import dataclass

MAX_MARKS = 60
MARK_ATTRIBUTE = "data-impa-mark"
LAYER_ID = "__impa_ai_marks"


@dataclass(frozen=True)
class Mark:
    n: int
    kind: str
    label: str
    x: float
    y: float
    width: float
    height: float

    def as_json(self) -> dict[str, object]:
        return {
            "n": self.n,
            "kind": self.kind,
            "label": self.label,
            "x": round(self.x),
            "y": round(self.y),
            "width": round(self.width),
            "height": round(self.height),
        }


def parse_marks(raw: object) -> tuple[Mark, ...]:
    """Validates what the page script returned (pages can tamper with their own globals)."""
    if not isinstance(raw, list):
        return ()
    marks = []
    for item in raw[:MAX_MARKS]:
        if not isinstance(item, dict):
            continue
        try:
            marks.append(
                Mark(
                    n=int(item["n"]),
                    kind=str(item.get("kind", "elemento"))[:20],
                    label=str(item.get("label", ""))[:60],
                    x=float(item["x"]),
                    y=float(item["y"]),
                    width=float(item["w"]),
                    height=float(item["h"]),
                )
            )
        except (KeyError, TypeError, ValueError):
            continue
    return tuple(marks)


_MARK_JS_TEMPLATE = """(limit) => {
  const ATTR = '__ATTR__';
  const LAYER = '__LAYER__';
  document.querySelectorAll('[' + ATTR + ']').forEach((e) => e.removeAttribute(ATTR));
  const old = document.getElementById(LAYER);
  if (old) old.remove();
  const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,'
    + '[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch],'
    + '[onclick],[tabindex]:not([tabindex="-1"])';
  const VISUAL = 'img,svg,canvas,video,picture,[role=img]';
  const isInteractive = (e) => e.matches(INTERACTIVE);
  const kindOf = (e, r) => {
    const tag = e.tagName.toLowerCase();
    if (tag === 'a' || e.getAttribute('role') === 'link') return 'link';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return 'campo';
    if (isInteractive(e)) return 'botão';
    if (tag === 'canvas') return 'gráfico';
    if (tag === 'video') return 'vídeo';
    if (tag === 'svg') return r.width * r.height > 40000 ? 'gráfico' : 'ícone';
    return 'imagem';
  };
  const onScreen = (e) => {
    const r = e.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return null;
    if (r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return null;
    const s = getComputedStyle(e);
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return null;
    return r;
  };
  const items = [];
  for (const e of document.querySelectorAll(INTERACTIVE + ',' + VISUAL)) {
    if (e.closest('#__impa_ai_cursor, #' + LAYER)) continue;
    const interactive = isInteractive(e);
    // An icon inside a button is the button; a shape inside an svg is the svg.
    if (!interactive && e.parentElement && e.parentElement.closest(INTERACTIVE)) continue;
    if (e.tagName.toLowerCase() !== 'svg' && e.closest('svg')) continue;
    const r = onScreen(e);
    if (r) items.push({ e, r, interactive });
  }
  const area = (it) => it.r.width * it.r.height;
  items.sort((a, b) => (b.interactive - a.interactive) || (area(b) - area(a)));
  const chosen = items.slice(0, limit)
    .sort((a, b) => (a.r.top - b.r.top) || (a.r.left - b.r.left));
  const layer = document.createElement('div');
  layer.id = LAYER;
  layer.setAttribute('aria-hidden', 'true');
  layer.style.cssText = 'position:fixed;inset:0;z-index:2147483645;pointer-events:none;';
  const out = [];
  chosen.forEach((it, i) => {
    const n = i + 1;
    it.e.setAttribute(ATTR, String(n));
    const { left, top, width, height } = it.r;
    const box = document.createElement('div');
    box.style.cssText = `position:fixed;left:${left}px;top:${top}px;width:${width}px;`
      + `height:${height}px;outline:2px solid #e0137a;outline-offset:-1px;`;
    const tag = document.createElement('span');
    tag.textContent = String(n);
    tag.style.cssText = `position:fixed;left:${Math.max(0, left)}px;top:${Math.max(0, top)}px;`
      + 'min-width:16px;padding:0 4px;font:700 12px/16px system-ui,sans-serif;color:#fff;'
      + 'background:#e0137a;border:1px solid #fff;border-radius:4px;text-align:center;';
    layer.appendChild(box);
    layer.appendChild(tag);
    const e = it.e;
    const label = (e.getAttribute('aria-label') || e.getAttribute('alt')
      || e.getAttribute('title') || e.getAttribute('placeholder') || e.innerText || e.value || '')
      .trim().replace(/\\s+/g, ' ');
    out.push({ n, kind: kindOf(e, it.r), label: label.slice(0, 60),
               x: it.r.left, y: it.r.top, w: it.r.width, h: it.r.height });
  });
  document.documentElement.appendChild(layer);
  return out;
}"""
MARK_JS = _MARK_JS_TEMPLATE.replace("__ATTR__", MARK_ATTRIBUTE).replace("__LAYER__", LAYER_ID)

CLEAR_MARKS_JS = f"""() => {{
  const layer = document.getElementById('{LAYER_ID}');
  if (layer) layer.remove();
}}"""

RING_JS = """([x, y, ms]) => {
  const ring = document.createElement('div');
  ring.className = '__impa_ai_highlight';
  ring.style.cssText = `position:fixed;left:${x - 26}px;top:${y - 26}px;width:52px;height:52px;`
    + 'border:3px solid #246fe5;border-radius:50%;z-index:2147483646;pointer-events:none;'
    + 'box-shadow:0 0 0 4px rgba(36,111,229,.25),0 0 24px rgba(36,111,229,.5);'
    + 'transition:opacity 400ms ease;opacity:1';
  document.documentElement.appendChild(ring);
  setTimeout(() => { ring.style.opacity = '0'; }, ms);
  setTimeout(() => ring.remove(), ms + 500);
}"""


def percent_to_viewport(
    x_pct: float, y_pct: float, width: float, height: float
) -> tuple[float, float]:
    """A position on the AI's capture (0 to 100 % of each side) in viewport pixels, clamped."""
    x = min(max(x_pct, 0.0), 100.0) / 100 * width
    y = min(max(y_pct, 0.0), 100.0) / 100 * height
    return min(x, width - 1), min(y, height - 1)
