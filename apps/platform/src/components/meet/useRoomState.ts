'use client';

import { useRoomInfo } from '@livekit/components-react';
import { useMemo } from 'react';
import { type RoomState, parseRoomState } from '@/lib/room-state';

/** What the platform says about the room (stage, recording, live), live from its metadata. */
export function useRoomState(): RoomState {
  const { metadata } = useRoomInfo();
  return useMemo(() => parseRoomState(metadata ?? ''), [metadata]);
}
