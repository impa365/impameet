import type { z } from 'zod';
import { audit } from '../audit';
import type { Sql } from '../db';
import { badRequest, forbidden } from '../errors';
import type { LiveKitAdmin } from '../livekit-admin';
import type { RoomModerator } from '../moderation/service';
import { publishRoomState } from '../room-state';
import type { Room } from '../rooms/service';
import type { studioStateInput } from '../validation';
import { type StudioState, parseStudio } from '@/lib/studio';

/** The room's stage as last set (an empty one before anybody produced it). */
export async function studioState(sql: Sql, room: Pick<Room, 'id'>): Promise<StudioState> {
  const [row] = await sql<
    { state: unknown }[]
  >`select studio_state as state from rooms where id = ${room.id}`;
  return parseStudio(row?.state ?? {});
}

/**
 * The producer changes the stage: kept on the room (for the next session) and pushed into the
 * running room's metadata, which every browser and the recorder's page follow at once. Who goes
 * on stage or off is audited; looks (layout, banners, brand) are not.
 */
export async function saveStudio(
  sql: Sql,
  lk: LiveKitAdmin,
  room: Room,
  who: RoomModerator | null,
  input: z.infer<typeof studioStateInput>,
  ip: string | null,
): Promise<StudioState> {
  if (!room.studio) throw badRequest('Esta sala não é um estúdio');
  if (!who) throw forbidden('Só quem produz o estúdio pode mudar o palco');
  const before = await studioState(sql, room);
  const state = parseStudio(input);
  await sql`update rooms set studio_state = ${sql.json(state as never)} where id = ${room.id}`;
  await publishRoomState(sql, lk, room);
  const joined = state.stage.filter((s) => !before.stage.includes(s));
  const left = before.stage.filter((s) => !state.stage.includes(s));
  if (joined.length || left.length) {
    await audit(sql, {
      tenantId: room.tenantId,
      actorId: who.userId,
      action: 'studio.stage',
      target: room.slug,
      meta: {
        joined: joined.join(','),
        left: left.join(','),
        ...(who.userId ? {} : { by: who.name }),
      },
      ip,
    });
  }
  return state;
}
