'use client';

import type { Participant, Room } from 'livekit-client';
import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/i18n/client';
import {
  CAPTIONER_ATTRIBUTE,
  CAPTIONS_TOPIC,
  type Caption,
  addCaption,
  parseCaption,
  visibleCaptions,
} from '@/lib/captions';
import { ApiError, api } from './api';

const TICK_MS = 1000;

/** Collects captions for the whole meeting (shown only when the user turns them on). */
export function useCaptions(room: Room) {
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    room.registerTextStreamHandler(CAPTIONS_TOPIC, async (reader) => {
      const caption = parseCaption(await reader.readAll(), Date.now());
      if (caption) setCaptions((list) => addCaption(list, caption));
    });
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => {
      room.unregisterTextStreamHandler(CAPTIONS_TOPIC);
      clearInterval(timer);
    };
  }, [room]);

  return visibleCaptions(captions, now);
}

export function captionerPresent(participants: Participant[]): boolean {
  return participants.some((p) => p.attributes?.[CAPTIONER_ATTRIBUTE] === 'captions');
}

/** Starting and stopping the meeting transcriber, for the members allowed to. */
export function useCaptionsControl(
  slug: string,
  signedIn: boolean,
  running: boolean,
  onError: (message: string) => void,
) {
  const t = useT();
  const [canControl, setCanControl] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!signedIn) return;
    api<{ canControl: boolean }>(`/api/rooms/${encodeURIComponent(slug)}/captions`)
      .then((r) => setCanControl(r.canControl))
      .catch(() => setCanControl(false));
  }, [slug, signedIn]);

  const toggleWorker = useCallback(async () => {
    setBusy(true);
    try {
      await api(`/api/rooms/${encodeURIComponent(slug)}/captions`, {
        method: running ? 'DELETE' : 'POST',
        body: {},
      });
    } catch (err) {
      onError(err instanceof ApiError ? err.message : t('room.errors.transcription'));
    } finally {
      setBusy(false);
    }
  }, [slug, running, onError, t]);

  return { canControl, busy, running, toggleWorker };
}

export function CaptionsOverlay({ captions }: { captions: Caption[] }) {
  if (captions.length === 0) return null;
  return (
    <div className="captions" aria-live="polite">
      {captions.map((c) => (
        <p key={c.id} className={c.final ? 'caption' : 'caption interim'}>
          <strong>{c.name}:</strong> {c.text}
        </p>
      ))}
    </div>
  );
}
