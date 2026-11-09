import { audit } from '../audit';
import type { SessionUser } from '../auth/session';
import type { Sql } from '../db';
import { badRequest, forbidden, notFound } from '../errors';
import type { LiveKitAdmin, LiveParticipant } from '../livekit-admin';
import { livekitRoomName } from '../livekit';
import { type Room, canManageAllRooms } from '../rooms/service';

export type ModerationAction = 'mute' | 'mute_all' | 'remove' | 'promote' | 'demote';

/** Identities issued to signed-in users start with `u-<user id>-`. */
export function isUsersIdentity(identity: string, userId: string): boolean {
  return identity.startsWith(`u-${userId}-`);
}

/**
 * A user moderates a room when they own it, run the organization (admin/manager), or were
 * promoted inside the live room (their own participant carries role=moderator).
 */
export async function canModerate(
  lk: LiveKitAdmin,
  room: Room,
  user: SessionUser | null,
  participants?: LiveParticipant[],
): Promise<boolean> {
  if (!user || user.tenantId !== room.tenantId) return false;
  if (room.ownerId === user.id || canManageAllRooms(user)) return true;
  const live = participants ?? (await lk.listParticipants(livekitRoomName(room.tenantId, room.slug)));
  return live.some((p) => p.role === 'moderator' && isUsersIdentity(p.identity, user.id));
}

export async function listLiveParticipants(
  lk: LiveKitAdmin,
  room: Room,
  user: SessionUser | null,
): Promise<{ participants: LiveParticipant[]; canModerate: boolean }> {
  const participants = await lk.listParticipants(livekitRoomName(room.tenantId, room.slug));
  return { participants, canModerate: await canModerate(lk, room, user, participants) };
}

export async function moderate(
  sql: Sql,
  lk: LiveKitAdmin,
  room: Room,
  user: SessionUser | null,
  action: ModerationAction,
  target: string | undefined,
  ip: string | null,
): Promise<{ affected: number }> {
  const lkRoom = livekitRoomName(room.tenantId, room.slug);
  const participants = await lk.listParticipants(lkRoom);
  if (!user || !(await canModerate(lk, room, user, participants)))
    throw forbidden('Só moderadores podem fazer isso');

  let affected = 0;
  if (action === 'mute_all') {
    for (const p of participants) {
      if (p.isAgent || isUsersIdentity(p.identity, user.id)) continue;
      for (const sid of p.audioTrackSids) await lk.muteTrack(lkRoom, p.identity, sid);
      affected += p.audioTrackSids.length > 0 ? 1 : 0;
    }
  } else {
    if (!target) throw badRequest('Informe o participante');
    const p = participants.find((x) => x.identity === target);
    if (!p) throw notFound('Participante não está na sala');
    if (isUsersIdentity(p.identity, user.id) && action !== 'mute')
      throw badRequest('Você não pode fazer isso com você mesmo');
    switch (action) {
      case 'mute':
        for (const sid of p.audioTrackSids) await lk.muteTrack(lkRoom, p.identity, sid);
        break;
      case 'remove':
        await lk.remove(lkRoom, p.identity);
        break;
      case 'promote':
        await lk.setRole(lkRoom, p.identity, 'moderator');
        break;
      case 'demote':
        await lk.setRole(lkRoom, p.identity, p.identity.startsWith('g-') ? 'guest' : 'participant');
        break;
    }
    affected = 1;
  }

  await audit(sql, {
    tenantId: room.tenantId,
    actorId: user.id,
    action: `moderation.${action}`,
    target: target ? `${room.slug}:${target}` : room.slug,
    meta: { affected },
    ip,
  });
  return { affected };
}
