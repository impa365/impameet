'use client';

import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { Room } from 'livekit-client';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/client';
import {
  type SyncElement,
  WHITEBOARD_TOPIC,
  type WhiteboardMessage,
  changedSince,
  decodeMessage,
  encodeMessage,
  mergeElements,
  rememberVersions,
} from '@/lib/whiteboard-sync';
import {
  type BoardChange,
  type Known,
  describeUpdate,
  rememberBoard,
  withDescription,
} from '@/lib/board-text';
import { BoardText } from './BoardText';

function BoardLoading() {
  const t = useT();
  return <p className="whiteboard-loading">{t('room.whiteboard.loading')}</p>;
}

const WhiteboardCanvas = dynamic(() => import('./WhiteboardCanvas'), {
  ssr: false,
  loading: BoardLoading,
});

const SEND_INTERVAL_MS = 150;
/** A first message this large into an empty board is a copy of what exists, not new drawing. */
const INITIAL_COPY_MIN = 5;
const MAX_CHANGES = 20;

/**
 * Keeps the shared drawing for the whole meeting, even while the board is closed, so
 * opening it later shows everything that was drawn and late joiners can be brought up to date.
 */
export function useWhiteboard(
  room: Room,
  mayDraw: (identity: string) => boolean,
  onRemoteChange?: (change: BoardChange) => void,
) {
  const elements = useRef<SyncElement[]>([]);
  const allowed = useRef(mayDraw);
  allowed.current = mayDraw;
  const notify = useRef(onRemoteChange);
  notify.current = onRemoteChange;
  const known = useRef(new Map<string, number>());
  /** What the text view knows: element versions, who last changed each one, recent changes. */
  const seen = useRef(new Map<string, Known>());
  const authors = useRef(new Map<string, string>());
  const [changes, setChanges] = useState<BoardChange[]>([]);
  const [revision, setRevision] = useState(0);
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [unseen, setUnseen] = useState(false);

  /** Records who changed what; a first full copy from someone else has no known authors. */
  const record = useCallback((incoming: readonly SyncElement[], author: string, remote: boolean) => {
    const firstCopy = remote && seen.current.size === 0 && incoming.length >= INITIAL_COPY_MIN;
    const change = describeUpdate(seen.current, incoming, author);
    if (!firstCopy) {
      for (const e of incoming)
        if ((seen.current.get(e.id)?.version ?? -1) < e.version) authors.current.set(e.id, author);
    }
    rememberBoard(seen.current, incoming);
    setRevision((r) => r + 1);
    if (!change || firstCopy) return;
    setChanges((list) => [change, ...list].slice(0, MAX_CHANGES));
    if (remote) notify.current?.(change);
  }, []);

  const send = useCallback(
    (message: WhiteboardMessage) => {
      room.localParticipant
        .sendText(encodeMessage(message), { topic: WHITEBOARD_TOPIC })
        .catch(() => undefined);
    },
    [room],
  );

  useEffect(() => {
    room.registerTextStreamHandler(WHITEBOARD_TOPIC, async (reader, sender) => {
      const message = decodeMessage(await reader.readAll());
      if (!message) return;
      if (message.type === 'request') {
        if (elements.current.length > 0) send({ type: 'scene', elements: elements.current });
        return;
      }
      if (!allowed.current(sender.identity)) return;
      record(message.elements, room.remoteParticipants.get(sender.identity)?.name || sender.identity, true);
      rememberVersions(message.elements, known.current);
      elements.current = mergeElements(elements.current, message.elements);
      if (api.current) api.current.updateScene({ elements: elements.current as never });
      else setUnseen(true);
    });
    return () => room.unregisterTextStreamHandler(WHITEBOARD_TOPIC);
  }, [room, send, record]);

  const flush = useCallback(() => {
    timer.current = null;
    if (!api.current || !allowed.current(room.localParticipant.identity)) return;
    elements.current = [...api.current.getSceneElementsIncludingDeleted()] as unknown as SyncElement[];
    const changed = changedSince(elements.current, known.current);
    if (changed.length === 0) return;
    rememberVersions(changed, known.current);
    record(changed, room.localParticipant.name || room.localParticipant.identity, false);
    send({ type: 'scene', elements: changed });
  }, [room, send, record]);

  /** Adds a description to an element (for people who cannot see it); everyone gets it. */
  const describe = useCallback(
    (id: string, alt: string) => {
      if (!allowed.current(room.localParticipant.identity)) return;
      const current = elements.current.find((e) => e.id === id);
      if (!current) return;
      const next = withDescription(current, alt);
      elements.current = mergeElements(elements.current, [next]);
      rememberVersions([next], known.current);
      record([next], room.localParticipant.name || room.localParticipant.identity, false);
      api.current?.updateScene({ elements: elements.current as never });
      send({ type: 'scene', elements: [next] });
    },
    [room, send, record],
  );

  const onChange = useCallback(() => {
    timer.current ??= setTimeout(flush, SEND_INTERVAL_MS);
  }, [flush]);

  const onReady = useCallback(
    (instance: ExcalidrawImperativeAPI | null) => {
      if (!instance) {
        if (timer.current) clearTimeout(timer.current);
        flush();
        api.current = null;
        return;
      }
      api.current = instance;
      setUnseen(false);
      send({ type: 'request' });
    },
    [flush, send],
  );

  return { elements, authors, changes, revision, describe, onChange, onReady, unseen };
}

export function WhiteboardPanel(props: {
  board: ReturnType<typeof useWhiteboard>;
  readOnly: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const { board } = props;
  const { onReady } = board;
  useEffect(() => () => onReady(null), [onReady]);
  return (
    <section
      className="whiteboard"
      aria-label={t('room.whiteboard.title')}
      aria-describedby="board-text-summary"
    >
      <header className="whiteboard-head">
        <strong>{t('room.whiteboard.title')}</strong>
        <span className="muted">
          {props.readOnly ? t('room.whiteboard.readOnly') : t('room.whiteboard.shared')}
        </span>
        <button className="btn secondary small" onClick={props.onClose}>
          {t('room.whiteboard.close')}
        </button>
      </header>
      <div className="whiteboard-canvas">
        <WhiteboardCanvas
          readOnly={props.readOnly}
          initialElements={board.elements.current}
          onReady={board.onReady}
          onChange={board.onChange}
        />
      </div>
      <BoardText board={board} canDescribe={!props.readOnly} />
    </section>
  );
}
