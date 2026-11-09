'use client';

import { type KeyboardEvent, useMemo, useRef, useState } from 'react';
import { type T, useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/keys';
import {
  type BoardChange,
  type BoardEnd,
  type BoardItem,
  type BoardKind,
  MAX_ALT,
  NEEDS_DESCRIPTION,
  boardItems,
  itemLabel,
} from '@/lib/board-text';
import type { SyncElement } from '@/lib/whiteboard-sync';

const KIND: Record<BoardKind, MessageKey> = {
  rectangle: 'room.whiteboard.kinds.rectangle',
  ellipse: 'room.whiteboard.kinds.ellipse',
  diamond: 'room.whiteboard.kinds.diamond',
  arrow: 'room.whiteboard.kinds.arrow',
  line: 'room.whiteboard.kinds.line',
  freedraw: 'room.whiteboard.kinds.freedraw',
  text: 'room.whiteboard.kinds.text',
  image: 'room.whiteboard.kinds.image',
  frame: 'room.whiteboard.kinds.frame',
  embed: 'room.whiteboard.kinds.embed',
  other: 'room.whiteboard.kinds.other',
};

const PLACE: Record<string, MessageKey> = {
  'top-left': 'room.whiteboard.place.topLeft',
  'top-center': 'room.whiteboard.place.top',
  'top-right': 'room.whiteboard.place.topRight',
  'middle-left': 'room.whiteboard.place.left',
  'middle-center': 'room.whiteboard.place.center',
  'middle-right': 'room.whiteboard.place.right',
  'bottom-left': 'room.whiteboard.place.bottomLeft',
  'bottom-center': 'room.whiteboard.place.bottom',
  'bottom-right': 'room.whiteboard.place.bottomRight',
};

/** One element, as a sentence a screen reader reads in one go. */
export function itemSentence(t: T, item: BoardItem): string {
  const kind = t(KIND[item.kind]);
  const parts = [item.text ? `${kind} “${item.text}”` : kind];
  if (item.alt) parts[0] += `: ${item.alt}`;
  else if (NEEDS_DESCRIPTION.has(item.kind)) parts[0] += ` (${t('room.whiteboard.noDescription')})`;
  if (item.from && item.to) {
    const end = (e: BoardEnd) => (e.text ? `“${e.text}”` : t(KIND[e.kind]).toLowerCase());
    parts.push(t('room.whiteboard.connects', { from: end(item.from), to: end(item.to) }));
  }
  parts.push(t(PLACE[`${item.row}-${item.col}`]));
  if (item.author) parts.push(t('room.whiteboard.by', { name: item.author }));
  return parts.join(', ');
}

/** "Ana adicionou “Meta” e mudou 2 elementos", for the change list and announcements. */
export function changeSentence(t: T, change: BoardChange): string {
  const parts: string[] = [];
  if (change.added === 1 && change.texts.length === 1)
    parts.push(t('room.whiteboard.addedText', { text: change.texts[0] }));
  else if (change.added === 1) parts.push(t('room.whiteboard.addedOne'));
  else if (change.added > 1) parts.push(t('room.whiteboard.addedMany', { count: change.added }));
  if (change.changed === 1) parts.push(t('room.whiteboard.changedOne'));
  else if (change.changed > 1) parts.push(t('room.whiteboard.changedMany', { count: change.changed }));
  if (change.removed === 1) parts.push(t('room.whiteboard.removedOne'));
  else if (change.removed > 1) parts.push(t('room.whiteboard.removedMany', { count: change.removed }));
  const last = parts.pop() ?? '';
  const what = parts.length > 0 ? `${parts.join(', ')} ${t('room.whiteboard.and')} ${last}` : last;
  return t('room.whiteboard.changeBy', { name: change.author, what });
}

interface BoardLike {
  elements: { current: SyncElement[] };
  authors: { current: Map<string, string> };
  changes: BoardChange[];
  revision: number;
  describe: (id: string, alt: string) => void;
}

/**
 * The board as a list a screen reader can walk through (arrow keys, Home, End): every element
 * with its text, place, links and author, and what changed recently. Updates never move focus.
 */
export function BoardText({ board, canDescribe }: { board: BoardLike; canDescribe: boolean }) {
  const t = useT();
  const { revision } = board;
  const items = useMemo(
    () => boardItems(board.elements.current, board.authors.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the refs change in place; revision says when
    [revision],
  );
  const [focused, setFocused] = useState<string | null>(null);
  const refs = useRef(new Map<string, HTMLLIElement>());
  const active = items.some((i) => i.id === focused) ? focused : (items[0]?.id ?? null);

  function move(e: KeyboardEvent<HTMLUListElement>) {
    const index = items.findIndex((i) => i.id === active);
    const next =
      e.key === 'ArrowDown'
        ? Math.min(index + 1, items.length - 1)
        : e.key === 'ArrowUp'
          ? Math.max(index - 1, 0)
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? items.length - 1
              : -1;
    if (next < 0 || (e.target as HTMLElement).tagName === 'BUTTON') return;
    e.preventDefault();
    const id = items[next].id;
    setFocused(id);
    refs.current.get(id)?.focus();
  }

  function describe(item: BoardItem) {
    const kind = t(KIND[item.kind]);
    const alt = window.prompt(
      t('room.whiteboard.describePrompt', { what: itemLabel(item) || kind }),
      item.alt,
    );
    if (alt !== null) board.describe(item.id, alt.slice(0, MAX_ALT));
  }

  return (
    <details className="board-text">
      <summary id="board-text-summary">
        {items.length === 0
          ? t('room.whiteboard.textSummaryEmpty')
          : t('room.whiteboard.textSummary', { count: items.length })}
      </summary>
      <p id="board-text-help" className="muted small-print">
        {t('room.whiteboard.textHelp')}
      </p>
      {items.length === 0 ? (
        <p>{t('room.whiteboard.empty')}</p>
      ) : (
        <ul
          className="board-items"
          aria-label={t('room.whiteboard.elements')}
          aria-describedby="board-text-help"
          onKeyDown={move}
        >
          {items.map((item) => (
            <li
              key={item.id}
              tabIndex={item.id === active ? 0 : -1}
              ref={(el) => {
                if (el) refs.current.set(item.id, el);
                else refs.current.delete(item.id);
              }}
              onFocus={() => setFocused(item.id)}
            >
              <span>{itemSentence(t, item)}</span>
              {canDescribe && (
                <button
                  type="button"
                  className="btn secondary small"
                  tabIndex={item.id === active ? 0 : -1}
                  aria-label={t('room.whiteboard.describeLabel', { what: itemSentence(t, item) })}
                  onClick={() => describe(item)}
                >
                  {item.alt ? t('room.whiteboard.editDescription') : t('room.whiteboard.describe')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <h3 className="board-changes-title">{t('room.whiteboard.changesTitle')}</h3>
      {board.changes.length === 0 ? (
        <p className="muted">{t('room.whiteboard.noChanges')}</p>
      ) : (
        <ol className="board-changes" aria-label={t('room.whiteboard.changesTitle')}>
          {board.changes.map((c) => (
            <li key={`${c.at}-${c.author}`}>
              <time dateTime={new Date(c.at).toISOString()}>
                {new Date(c.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </time>{' '}
              {changeSentence(t, c)}
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}
