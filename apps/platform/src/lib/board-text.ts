/**
 * The whiteboard as text, for people who use a screen reader: what each element is, what it
 * says, where it is, what it connects and who drew it, plus what changed and by whom. Built
 * from the synchronised Excalidraw elements (never from pixels).
 */
import type { SyncElement } from './whiteboard-sync';

export type BoardKind =
  | 'rectangle'
  | 'ellipse'
  | 'diamond'
  | 'arrow'
  | 'line'
  | 'freedraw'
  | 'text'
  | 'image'
  | 'frame'
  | 'embed'
  | 'other';

export type Row = 'top' | 'middle' | 'bottom';
export type Col = 'left' | 'center' | 'right';

export interface BoardEnd {
  text: string;
  kind: BoardKind;
}

export interface BoardItem {
  id: string;
  kind: BoardKind;
  /** What it says (its own text, or the text inside a shape). */
  text: string;
  /** A description someone added (images, drawings, anything). */
  alt: string;
  row: Row;
  col: Col;
  /** For connectors bound at both ends: what they connect (its text, or just its kind). */
  from?: BoardEnd;
  to?: BoardEnd;
  author: string | null;
}

/** Elements whose picture carries the meaning: without a description they say nothing. */
export const NEEDS_DESCRIPTION: ReadonlySet<BoardKind> = new Set(['image', 'freedraw', 'embed']);
export const MAX_ALT = 500;

const KINDS: Record<string, BoardKind> = {
  rectangle: 'rectangle',
  ellipse: 'ellipse',
  diamond: 'diamond',
  arrow: 'arrow',
  line: 'line',
  freedraw: 'freedraw',
  text: 'text',
  image: 'image',
  frame: 'frame',
  magicframe: 'frame',
  embeddable: 'embed',
  iframe: 'embed',
};

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export function altOf(e: SyncElement): string {
  const custom = e.customData as { alt?: unknown } | undefined;
  return str(custom?.alt).slice(0, MAX_ALT);
}

function third<T>(value: number, low: number, high: number, names: [T, T, T]): T {
  if (high - low < 1) return names[1];
  const part = (value - low) / (high - low);
  return part < 1 / 3 ? names[0] : part > 2 / 3 ? names[2] : names[1];
}

/** The board's visible elements, top to bottom then left to right (reading order). */
export function boardItems(
  elements: readonly SyncElement[],
  authors: ReadonlyMap<string, string>,
): BoardItem[] {
  const live = elements.filter((e) => !e.isDeleted);
  const labels = new Map<string, string>();
  for (const e of live) {
    if (e.type === 'text' && typeof e.containerId === 'string') labels.set(e.containerId, str(e.text));
  }
  const shown = live.filter((e) => !(e.type === 'text' && e.containerId));
  if (shown.length === 0) return [];
  const xs = shown.flatMap((e) => [num(e.x), num(e.x) + num(e.width)]);
  const ys = shown.flatMap((e) => [num(e.y), num(e.y) + num(e.height)]);
  const [left, right, top, bottom] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];

  const base = shown.map((e) => {
    const cx = num(e.x) + num(e.width) / 2;
    const cy = num(e.y) + num(e.height) / 2;
    return {
      e,
      cx,
      cy,
      item: {
        id: e.id,
        kind: KINDS[String(e.type)] ?? 'other',
        text: e.type === 'text' ? str(e.text) : (labels.get(e.id) ?? ''),
        alt: altOf(e),
        row: third<Row>(cy, top, bottom, ['top', 'middle', 'bottom']),
        col: third<Col>(cx, left, right, ['left', 'center', 'right']),
        author: authors.get(e.id) ?? null,
      } as BoardItem,
    };
  });
  const byId = new Map(base.map((b) => [b.e.id, b.item]));
  for (const { e, item } of base) {
    if (item.kind !== 'arrow' && item.kind !== 'line') continue;
    const start = byId.get(str((e.startBinding as { elementId?: unknown } | null)?.elementId));
    const end = byId.get(str((e.endBinding as { elementId?: unknown } | null)?.elementId));
    if (start && end) {
      item.from = { text: itemLabel(start), kind: start.kind };
      item.to = { text: itemLabel(end), kind: end.kind };
    }
  }
  const rowOrder: Record<Row, number> = { top: 0, middle: 1, bottom: 2 };
  return base
    .sort((a, b) => rowOrder[a.item.row] - rowOrder[b.item.row] || a.cx - b.cx || a.cy - b.cy)
    .map((b) => b.item);
}

/** How other items refer to this one: its text, its description, or nothing (the caller names its kind). */
export function itemLabel(item: Pick<BoardItem, 'text' | 'alt' | 'kind'>): string {
  return (item.text || item.alt).slice(0, 120);
}

export interface Known {
  version: number;
  deleted: boolean;
}

export interface BoardChange {
  author: string;
  added: number;
  changed: number;
  removed: number;
  /** Texts of what was added, for "Ana added “Meta”". */
  texts: string[];
  at: number;
}

/** What one incoming update does to the board, before it is merged. Null when nothing visible changes. */
export function describeUpdate(
  known: ReadonlyMap<string, Known>,
  incoming: readonly SyncElement[],
  author: string,
  at = Date.now(),
): BoardChange | null {
  const change: BoardChange = { author, added: 0, changed: 0, removed: 0, texts: [], at };
  for (const e of incoming) {
    const before = known.get(e.id);
    if (before && e.version <= before.version) continue;
    const deleted = Boolean(e.isDeleted);
    if (!before || before.deleted) {
      if (deleted) continue;
      change.added += 1;
      const text = str(e.text);
      if (text && change.texts.length < 3) change.texts.push(text.slice(0, 60));
    } else if (deleted) change.removed += 1;
    else change.changed += 1;
  }
  return change.added + change.changed + change.removed > 0 ? change : null;
}

export function rememberBoard(known: Map<string, Known>, elements: readonly SyncElement[]): void {
  for (const e of elements) {
    const before = known.get(e.id);
    if (!before || e.version > before.version)
      known.set(e.id, { version: e.version, deleted: Boolean(e.isDeleted) });
  }
}

export type BoardAnnounce = 'all' | 'summary' | 'off';
export const BOARD_ANNOUNCE: readonly BoardAnnounce[] = ['all', 'summary', 'off'];
/** "all": a short pause gathers a burst of edits into one sentence. */
export const ALL_DELAY_MS = 2500;
/** "summary": at most one sentence this often, however much people draw. */
export const SUMMARY_INTERVAL_MS = 30_000;

/** Changes gathered between two announcements, grouped by who made them. */
export class ChangeDigest {
  private pending = new Map<string, BoardChange>();
  private lastSaid = Number.NEGATIVE_INFINITY;

  add(change: BoardChange): void {
    const sum = this.pending.get(change.author);
    if (!sum) {
      this.pending.set(change.author, { ...change, texts: [...change.texts] });
      return;
    }
    sum.added += change.added;
    sum.changed += change.changed;
    sum.removed += change.removed;
    for (const t of change.texts) if (sum.texts.length < 3) sum.texts.push(t);
    sum.at = change.at;
  }

  /** When the next announcement may happen in this mode (null: never). */
  dueAt(mode: BoardAnnounce, now: number): number | null {
    if (mode === 'off' || this.pending.size === 0) return null;
    const latest = Math.max(...[...this.pending.values()].map((c) => c.at));
    if (mode === 'all') return Math.max(latest + ALL_DELAY_MS, now);
    return Math.max(this.lastSaid + SUMMARY_INTERVAL_MS, latest + ALL_DELAY_MS, now);
  }

  /** The changes to say now, and forget them. */
  take(now: number): BoardChange[] {
    const out = [...this.pending.values()];
    this.pending.clear();
    if (out.length > 0) this.lastSaid = now;
    return out;
  }

  clear(): void {
    this.pending.clear();
  }
}

/** The element with a description added: a new version, so every browser adopts it. */
export function withDescription(e: SyncElement, alt: string): SyncElement {
  return {
    ...e,
    customData: {
      ...((e.customData as Record<string, unknown> | undefined) ?? {}),
      alt: alt.trim().slice(0, MAX_ALT),
    },
    version: e.version + 1,
    versionNonce: Math.floor(Math.random() * 2 ** 31),
    updated: Date.now(),
  };
}
