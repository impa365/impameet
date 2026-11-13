import type { Sql } from './db';
import type { LiveKitAdmin } from './livekit-admin';
import { livekitRoomName } from './livekit';
import type { Room } from './rooms/service';
import type { RoomState } from '@/lib/room-state';
import { parseStudio } from '@/lib/studio';

type RoomRef = Pick<Room, 'id' | 'tenantId' | 'slug' | 'studio'>;

/** The room's state as the database has it: the stage, a recording running, a live running. */
export async function roomStateOf(sql: Sql, room: RoomRef): Promise<RoomState> {
  const [row] = await sql<
    { studio: unknown; recording: boolean; since: Date | null; targets: { name?: unknown }[] | null }[]
  >`
    select r.studio_state as studio,
      exists (select 1 from recordings x where x.room_id = r.id and x.status in ('starting', 'recording'))
        as recording,
      l.started_at as since, l.targets
    from rooms r
    left join live_streams l on l.room_id = r.id and l.status in ('starting', 'live')
    where r.id = ${room.id}`;
  return {
    studio: room.studio ? parseStudio(row?.studio ?? {}) : null,
    recording: row?.recording ?? false,
    live: row?.since
      ? {
          since: new Date(row.since).toISOString(),
          to: (row.targets ?? []).map((t) => String(t.name ?? '')).filter(Boolean),
        }
      : null,
  };
}

/**
 * Pushes it to the running room (nothing to do when nobody is in it: the next join carries it).
 * Never fails the caller: the change itself is already saved.
 */
export async function publishRoomState(sql: Sql, lk: LiveKitAdmin, room: RoomRef): Promise<RoomState> {
  const state = await roomStateOf(sql, room);
  await lk
    .updateRoomMetadata?.(livekitRoomName(room.tenantId, room.slug), JSON.stringify(state))
    .catch(() => undefined);
  return state;
}

/** Same, from a room id (background work that only has the id). */
export async function publishRoomStateById(sql: Sql, lk: LiveKitAdmin, roomId: string): Promise<void> {
  const [room] = await sql<RoomRef[]>`
    select id, tenant_id as "tenantId", slug, studio from rooms where id = ${roomId}`;
  if (room) await publishRoomState(sql, lk, room);
}
