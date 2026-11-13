'use client';

import type { Room } from 'livekit-client';
import { RoomEvent } from 'livekit-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/client';
import { ApiError, api } from '../api';

/** Egress opens a browser before it records; past this, a start that did not happen failed. */
const START_CHECK_MS = 45_000;

/**
 * What the moderator sees, right when they click. The server accepts a start or a stop at once,
 * but LiveKit only reports the change once the recorder really started (it opens a browser
 * first) or finished the file, seconds later; waiting for that made the button look stuck.
 */
export type RecordingPhase = 'idle' | 'starting' | 'recording' | 'stopping';

/** Everyone sees when the meeting is recorded; moderators of plans with recording can toggle it. */
export function useRecording(
  room: Room,
  slug: string,
  signedIn: boolean,
  onError: (message: string) => void,
) {
  const t = useT();
  const path = `/api/rooms/${encodeURIComponent(slug)}/recording`;
  // Confirmed by LiveKit: drives the "recording" notice everyone sees.
  const [recording, setRecording] = useState(room.isRecording);
  const [phase, setPhase] = useState<RecordingPhase>(room.isRecording ? 'recording' : 'idle');
  const [canRecord, setCanRecord] = useState(false);
  const [busy, setBusy] = useState(false);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  /** A stop someone asked for (so LiveKit's "stopped" is not taken for a failure). */
  const stopping = useRef(false);

  /** Asks the server (which checks with the recorder) whether the last recording failed. */
  const checkFailure = useCallback(async () => {
    const r = await api<{ failure: { error: string | null } | null }>(path).catch(() => null);
    if (r?.failure && !room.isRecording) {
      setPhase('idle');
      onError(t('room.errors.recordingFailed'));
    }
  }, [room, path, onError, t]);

  useEffect(() => {
    const update = (value: boolean) => {
      setRecording(value);
      if (value) {
        // A stop clicked while the recorder was still opening: the stop already went through.
        if (phaseRef.current !== 'idle' || !stopping.current) setPhase('recording');
        return;
      }
      // Stopped without anyone asking: the recorder failed (a moderator can record again).
      if (!stopping.current && canRecord) void checkFailure();
      stopping.current = false;
      setPhase((p) => (p === 'starting' ? p : 'idle'));
    };
    room.on(RoomEvent.RecordingStatusChanged, update);
    return () => {
      room.off(RoomEvent.RecordingStatusChanged, update);
    };
  }, [room, canRecord, checkFailure]);

  useEffect(() => {
    if (!signedIn) return;
    api<{ canRecord: boolean; active: { status: string } | null }>(path)
      .then((r) => {
        setCanRecord(r.canRecord);
        // Someone already started it and the recorder is still opening.
        if (r.active && !room.isRecording) setPhase('starting');
      })
      .catch(() => setCanRecord(false));
  }, [path, signedIn, room]);

  const toggle = useCallback(async () => {
    if (busy) return;
    const start = phase === 'idle';
    setBusy(true);
    setPhase(start ? 'starting' : 'stopping');
    stopping.current = !start;
    try {
      await api(path, { method: start ? 'POST' : 'DELETE', body: {} });
      if (start) {
        // Confirmed already (fast recorder), or wait for LiveKit; check back if it never comes.
        if (room.isRecording) setPhase('recording');
        setTimeout(() => {
          if (phaseRef.current === 'starting') void checkFailure();
        }, START_CHECK_MS);
      } else {
        // The server stopped it: for the moderator it is over now, LiveKit catches up later.
        setPhase('idle');
      }
    } catch (err) {
      const conflict = err instanceof ApiError && (err.status === 409 || err.status === 404);
      stopping.current = false;
      // "Already recording" / "not recording": someone else was faster; follow the real state.
      setPhase(conflict ? (start ? 'starting' : 'idle') : start ? 'idle' : 'recording');
      if (!conflict) onError(err instanceof ApiError ? err.message : t('room.errors.recording'));
    } finally {
      setBusy(false);
    }
  }, [busy, phase, path, room, onError, t, checkFailure]);

  return { recording, phase, canRecord, busy, toggle };
}
