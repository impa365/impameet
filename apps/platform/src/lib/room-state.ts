import { type StudioState, parseStudio } from './studio';

/**
 * What the platform tells every browser in the room through the LiveKit room metadata. LiveKit's
 * own "recording" flag turns on for any recorder in the room (a live stream too), so recording
 * and going live are told apart here.
 */
export interface RoomLive {
  since: string;
  /** Destination names, e.g. "YouTube · Canal da Empresa". */
  to: string[];
}

export interface RoomState {
  /** Null in a meeting; the stage in a studio. */
  studio: StudioState | null;
  recording: boolean;
  live: RoomLive | null;
}

export const EMPTY_ROOM_STATE: RoomState = { studio: null, recording: false, live: null };

/** Reads the room metadata: anything unknown falls back, never throws. */
export function parseRoomState(raw: unknown): RoomState {
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return EMPTY_ROOM_STATE;
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return EMPTY_ROOM_STATE;
  const d = data as Record<string, unknown>;
  const live = d.live && typeof d.live === 'object' ? (d.live as Record<string, unknown>) : null;
  return {
    studio: d.studio && typeof d.studio === 'object' ? parseStudio(d.studio) : null,
    recording: d.recording === true,
    live:
      live && typeof live.since === 'string'
        ? {
            since: live.since,
            to: Array.isArray(live.to)
              ? live.to.filter((x): x is string => typeof x === 'string').slice(0, 10)
              : [],
          }
        : null,
  };
}
