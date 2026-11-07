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

function BoardLoading() {
  const t = useT();
  return <p className="whiteboard-loading">{t('room.whiteboard.loading')}</p>;
}

const WhiteboardCanvas = dynamic(() => import('./WhiteboardCanvas'), {
  ssr: false,
  loading: BoardLoading,
});

const SEND_INTERVAL_MS = 150;

/**
 * Keeps the shared drawing for the whole meeting, even while the board is closed, so
 * opening it later shows everything that was drawn and late joiners can be brought up to date.
 */
export function useWhiteboard(room: Room, mayDraw: (identity: string) => boolean) {
  const elements = useRef<SyncElement[]>([]);
  const allowed = useRef(mayDraw);
  allowed.current = mayDraw;
  const known = useRef(new Map<string, number>());
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [unseen, setUnseen] = useState(false);

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
      rememberVersions(message.elements, known.current);
      elements.current = mergeElements(elements.current, message.elements);
      if (api.current) api.current.updateScene({ elements: elements.current as never });
      else setUnseen(true);
    });
    return () => room.unregisterTextStreamHandler(WHITEBOARD_TOPIC);
  }, [room, send]);

  const flush = useCallback(() => {
    timer.current = null;
    if (!api.current || !allowed.current(room.localParticipant.identity)) return;
    elements.current = [...api.current.getSceneElementsIncludingDeleted()] as unknown as SyncElement[];
    const changed = changedSince(elements.current, known.current);
    if (changed.length === 0) return;
    rememberVersions(changed, known.current);
    send({ type: 'scene', elements: changed });
  }, [room, send]);

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

  return { elements, onChange, onReady, unseen };
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
    <section className="whiteboard" aria-label={t('room.whiteboard.title')}>
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
    </section>
  );
}
