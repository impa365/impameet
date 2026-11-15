import { describe, expect, it } from 'vitest';
import { EMPTY_ROOM_STATE, parseRoomState } from '@/lib/room-state';
import { EMPTY_STUDIO } from '@/lib/studio';

describe('room state', () => {
  it('reads what the platform tells the room', () => {
    const studio = {
      ...EMPTY_STUDIO,
      scenes: EMPTY_STUDIO.scenes.map((s) =>
        s.id === EMPTY_STUDIO.programId ? { ...s, layout: 'solo' as const, stage: ['g-a'] } : s,
      ),
    };
    const state = {
      studio,
      recording: true,
      live: { since: '2026-11-13T22:00:00.000Z', to: ['YouTube · Canal', 'Twitch'] },
    };
    expect(parseRoomState(JSON.stringify(state))).toEqual(state);
    expect(parseRoomState(state)).toEqual(state);
  });

  it('never throws: anything unknown falls back', () => {
    for (const raw of ['', 'nope', '[]', '42', null, undefined, [], {}])
      expect(parseRoomState(raw)).toEqual(EMPTY_ROOM_STATE);
    expect(parseRoomState({ studio: 'x', recording: 'yes', live: { since: 5 } })).toEqual(EMPTY_ROOM_STATE);
    expect(parseRoomState({ live: { since: 'now', to: ['a', 3, null] } }).live).toEqual({
      since: 'now',
      to: ['a'],
    });
    expect(parseRoomState({ live: { since: 'now', to: 'a' } }).live).toEqual({ since: 'now', to: [] });
    expect(parseRoomState({ studio: { layout: 'mosaic' } }).studio).toEqual(EMPTY_STUDIO);
  });
});
