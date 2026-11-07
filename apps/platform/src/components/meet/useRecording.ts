'use client';

import type { Room } from 'livekit-client';
import { RoomEvent } from 'livekit-client';
import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/i18n/client';
import { ApiError, api } from '../api';

/** Everyone sees when the meeting is recorded; moderators of plans with recording can toggle it. */
export function useRecording(
  room: Room,
  slug: string,
  signedIn: boolean,
  onError: (message: string) => void,
) {
  const t = useT();
  const [recording, setRecording] = useState(room.isRecording);
  const [canRecord, setCanRecord] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const update = (value: boolean) => setRecording(value);
    room.on(RoomEvent.RecordingStatusChanged, update);
    return () => {
      room.off(RoomEvent.RecordingStatusChanged, update);
    };
  }, [room]);

  useEffect(() => {
    if (!signedIn) return;
    api<{ canRecord: boolean }>(`/api/rooms/${encodeURIComponent(slug)}/recording`)
      .then((r) => setCanRecord(r.canRecord))
      .catch(() => setCanRecord(false));
  }, [slug, signedIn]);

  const toggle = useCallback(async () => {
    setBusy(true);
    try {
      await api(`/api/rooms/${encodeURIComponent(slug)}/recording`, {
        method: recording ? 'DELETE' : 'POST',
        body: {},
      });
    } catch (err) {
      onError(err instanceof ApiError ? err.message : t('room.errors.recording'));
    } finally {
      setBusy(false);
    }
  }, [slug, recording, onError, t]);

  return { recording, canRecord, busy, toggle };
}
