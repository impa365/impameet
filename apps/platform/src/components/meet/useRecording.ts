'use client';

import type { Room } from 'livekit-client';
import { RoomEvent } from 'livekit-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/client';
import { ApiError, api } from '../api';
import { useRoomState } from './useRoomState';

/** Egress opens a browser before it records; past this, a start that did not happen failed. */
const START_CHECK_MS = 45_000;

/**
 * What the moderator sees, right when they click. The server accepts a start or a stop at once,
 * but the recorder only joins once it really started (it opens a browser first), seconds later;
 * waiting for that made the button look stuck.
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
  // LiveKit's flag turns on for any recorder in the room (a live stream too), so it only
  // confirms what the platform announced: a recording is running.
  const announced = useRoomState().recording;
  const [recorderIn, setRecorderIn] = useState(room.isRecording);
  const recording = announced && recorderIn;
  const recordingRef = useRef(recording);
  const [phase, setPhase] = useState<RecordingPhase>(recording ? 'recording' : 'idle');
  const [canRecord, setCanRecord] = useState(false);
  const [busy, setBusy] = useState(false);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  /** A stop someone asked for (so the recording ending is not taken for a failure). */
  const stopping = useRef(false);

  useEffect(() => {
    const update = (value: boolean) => setRecorderIn(value);
    setRecorderIn(room.isRecording);
    room.on(RoomEvent.RecordingStatusChanged, update);
    return () => {
      room.off(RoomEvent.RecordingStatusChanged, update);
    };
  }, [room]);

  /** Asks the server (which checks with the recorder) whether the last recording failed. */
  const checkFailure = useCallback(async () => {
    const r = await api<{ failure: { error: string | null } | null }>(path).catch(() => null);
    if (r?.failure && !recordingRef.current) {
      setPhase('idle');
      onError(t('room.errors.recordingFailed'));
    }
  }, [path, onError, t]);

  useEffect(() => {
    if (recording === recordingRef.current) return;
    recordingRef.current = recording;
    if (recording) {
      // A stop clicked while the recorder was still opening: the stop already went through.
      if (phaseRef.current !== 'idle' || !stopping.current) setPhase('recording');
      return;
    }
    // Ended without anyone here asking: the recorder may have failed (a moderator can record again).
    if (!stopping.current && canRecord) void checkFailure();
    stopping.current = false;
    setPhase((p) => (p === 'starting' ? p : 'idle'));
  }, [recording, canRecord, checkFailure]);

  useEffect(() => {
    if (!signedIn) return;
    api<{ canRecord: boolean; active: { status: string } | null }>(path)
      .then((r) => {
        setCanRecord(r.canRecord);
        // Someone already started it and the recorder is still opening.
        if (r.active && !recordingRef.current) setPhase('starting');
      })
      .catch(() => setCanRecord(false));
  }, [path, signedIn]);

  const toggle = useCallback(async () => {
    if (busy) return;
    const start = phase === 'idle';
    setBusy(true);
    setPhase(start ? 'starting' : 'stopping');
    stopping.current = !start;
    try {
      await api(path, { method: start ? 'POST' : 'DELETE', body: {} });
      if (start) {
        // Confirmed when the recorder joins; check back if it never does.
        setTimeout(() => {
          if (phaseRef.current === 'starting') void checkFailure();
        }, START_CHECK_MS);
      } else {
        // The server stopped it: for the moderator it is over now.
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
  }, [busy, phase, path, onError, t, checkFailure]);

  return { recording, phase, canRecord, busy, toggle };
}
