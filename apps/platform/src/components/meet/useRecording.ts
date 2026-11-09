'use client';

import type { Room } from 'livekit-client';
import { RoomEvent } from 'livekit-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/client';
import { ApiError, api } from '../api';

/** Egress opens a browser before it records; past this, a start that did not happen failed. */
const START_CHECK_MS = 45_000;

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
  const stopping = useRef(false);

  /** Asks the server (which checks with the recorder) whether the last recording failed. */
  const checkFailure = useCallback(async () => {
    const r = await api<{ failure: { error: string | null } | null }>(
      `/api/rooms/${encodeURIComponent(slug)}/recording`,
    ).catch(() => null);
    if (r?.failure && !room.isRecording) onError(t('room.errors.recordingFailed'));
  }, [room, slug, onError, t]);

  useEffect(() => {
    const update = (value: boolean) => {
      setRecording(value);
      // Stopped without anyone asking: the recorder failed (a moderator can record again).
      if (!value && !stopping.current && canRecord) void checkFailure();
      if (!value) stopping.current = false;
    };
    room.on(RoomEvent.RecordingStatusChanged, update);
    return () => {
      room.off(RoomEvent.RecordingStatusChanged, update);
    };
  }, [room, canRecord, checkFailure]);

  useEffect(() => {
    if (!signedIn) return;
    api<{ canRecord: boolean }>(`/api/rooms/${encodeURIComponent(slug)}/recording`)
      .then((r) => setCanRecord(r.canRecord))
      .catch(() => setCanRecord(false));
  }, [slug, signedIn]);

  const toggle = useCallback(async () => {
    setBusy(true);
    stopping.current = recording;
    try {
      await api(`/api/rooms/${encodeURIComponent(slug)}/recording`, {
        method: recording ? 'DELETE' : 'POST',
        body: {},
      });
      // A recorder that fails while opening never reports "recording": check back on it.
      if (!recording) setTimeout(() => void checkFailure(), START_CHECK_MS);
    } catch (err) {
      stopping.current = false;
      onError(err instanceof ApiError ? err.message : t('room.errors.recording'));
    } finally {
      setBusy(false);
    }
  }, [slug, recording, onError, t, checkFailure]);

  return { recording, canRecord, busy, toggle };
}
