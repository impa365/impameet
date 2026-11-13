import { TokenVerifier } from 'livekit-server-sdk';
import { audit } from '../audit';
import type { SessionUser } from '../auth/session';
import type { Sql } from '../db';
import { badRequest, forbidden, notFound } from '../errors';
import type { LiveKitAdmin, LiveParticipant } from '../livekit-admin';
import { livekitRoomName } from '../livekit';
import { type Room, findRoom, managesRoom } from '../rooms/service';

export type ModerationAction = 'mute' | 'mute_all' | 'remove' | 'promote' | 'demote';

/** Header with the caller's LiveKit token: how a promoted guest (no account) proves who they are. */
export const ROOM_TOKEN_HEADER = 'x-room-token';

/** Identities issued to signed-in users start with `u-<user id>-`. */
export function isUsersIdentity(identity: string, userId: string): boolean {
  return identity.startsWith(`u-${userId}-`);
}

/** Who a valid LiveKit token of this server says the caller is. */
export interface TokenClaims {
  identity: string;
  room: string;
  name: string;
}
export type VerifyToken = (token: string) => Promise<TokenClaims | null>;

export function tokenVerifier(apiKey: string, apiSecret: string): VerifyToken {
  const verifier = new TokenVerifier(apiKey, apiSecret);
  return async (token) => {
    const claims = await verifier.verify(token).catch(() => null);
    if (!claims?.sub || !claims.video?.room) return null;
    return { identity: claims.sub, room: claims.video.room, name: claims.name || claims.sub };
  };
}

/**
 * Someone allowed to moderate this meeting. The organizer (owner, admin, manager) may do
 * everything; anyone promoted in the live room may moderate only while that participant is in
 * the meeting: their permission is the live `role=moderator` itself, so it ends when they leave
 * (a guest who comes back is a guest again).
 */
export interface RoomModerator {
  /** For the audit log; null for a promoted guest. */
  userId: string | null;
  /** Their participant in the meeting (null for an organizer acting from outside it). */
  identity: string | null;
  name: string;
  organizer: boolean;
}

export async function roomModerator(
  lk: LiveKitAdmin,
  room: Room,
  user: SessionUser | null,
  opts: { participants?: LiveParticipant[]; token?: string | null; verify?: VerifyToken } = {},
): Promise<RoomModerator | null> {
  const mine = !!user && user.tenantId === room.tenantId;
  if (mine && managesRoom(room, user)) {
    return { userId: user.id, identity: null, name: user.name, organizer: true };
  }
  const lkRoom = livekitRoomName(room.tenantId, room.slug);
  const live = opts.participants ?? (await lk.listParticipants(lkRoom));
  const promoted = (identity: string) => live.find((p) => p.identity === identity && p.role === 'moderator');
  if (mine) {
    const p = live.find((x) => x.role === 'moderator' && isUsersIdentity(x.identity, user.id));
    if (p) return { userId: user.id, identity: p.identity, name: user.name, organizer: false };
  }
  if (opts.token && opts.verify) {
    const claims = await opts.verify(opts.token);
    const p = claims && claims.room === lkRoom ? promoted(claims.identity) : undefined;
    if (p) {
      const userId = mine && isUsersIdentity(p.identity, user.id) ? user.id : null;
      return { userId, identity: p.identity, name: p.name || claims!.name, organizer: false };
    }
  }
  return null;
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
  return (await roomModerator(lk, room, user, { participants })) !== null;
}

export async function listLiveParticipants(
  lk: LiveKitAdmin,
  room: Room,
  user: SessionUser | null,
  opts: { token?: string | null; verify?: VerifyToken } = {},
): Promise<{ participants: LiveParticipant[]; canModerate: boolean; organizer: boolean }> {
  const participants = await lk.listParticipants(livekitRoomName(room.tenantId, room.slug));
  const who = await roomModerator(lk, room, user, { ...opts, participants });
  return { participants, canModerate: who !== null, organizer: who?.organizer ?? false };
}

export interface MeetingControls {
  boardPolicy?: 'everyone' | 'moderators';
  pollsPolicy?: 'everyone' | 'moderators';
  thinkingSound?: boolean;
  agentActions?: boolean;
}

/**
 * The meeting's own controls (who may draw and create polls, the AI acting, its typing sound),
 * which any moderator of the live meeting may change. Access, password, invites and the room's
 * agents remain the organizer's.
 */
export async function setMeetingControls(
  sql: Sql,
  room: Room,
  who: RoomModerator,
  patch: MeetingControls,
  ip: string | null,
): Promise<Room> {
  await sql`
    update rooms set
      board_policy = coalesce(${patch.boardPolicy ?? null}::text, board_policy),
      polls_policy = coalesce(${patch.pollsPolicy ?? null}::text, polls_policy),
      thinking_sound = coalesce(${patch.thinkingSound ?? null}::boolean, thinking_sound),
      agent_actions = coalesce(${patch.agentActions ?? null}::boolean, agent_actions)
    where id = ${room.id}`;
  await audit(sql, {
    tenantId: room.tenantId,
    actorId: who.userId,
    action: 'room.meeting_controls',
    target: room.slug,
    meta: { ...patch, ...(who.userId ? {} : { by: who.name, identity: who.identity ?? '' }) },
    ip,
  });
  const updated = await findRoom(sql, room.tenantId, room.slug);
  if (!updated) throw notFound('Sala não encontrada');
  return updated;
}

/** Promoting and demoting stay with the organizer; promoted moderators never act on moderators. */
const ORGANIZER_ONLY: readonly ModerationAction[] = ['promote', 'demote'];

export async function moderate(
  sql: Sql,
  lk: LiveKitAdmin,
  room: Room,
  user: SessionUser | null,
  action: ModerationAction,
  target: string | undefined,
  ip: string | null,
  opts: { token?: string | null; verify?: VerifyToken } = {},
): Promise<{ affected: number }> {
  const lkRoom = livekitRoomName(room.tenantId, room.slug);
  const participants = await lk.listParticipants(lkRoom);
  const who = await roomModerator(lk, room, user, { ...opts, participants });
  if (!who) throw forbidden('Só moderadores podem fazer isso');
  if (!who.organizer && ORGANIZER_ONLY.includes(action))
    throw forbidden('Só o organizador da sala pode promover ou remover moderadores');
  const isSelf = (identity: string) =>
    identity === who.identity || (who.userId !== null && isUsersIdentity(identity, who.userId));

  let affected = 0;
  if (action === 'mute_all') {
    for (const p of participants) {
      if (p.isAgent || isSelf(p.identity)) continue;
      for (const sid of p.audioTrackSids) await lk.muteTrack(lkRoom, p.identity, sid);
      affected += p.audioTrackSids.length > 0 ? 1 : 0;
    }
  } else {
    if (!target) throw badRequest('Informe o participante');
    const p = participants.find((x) => x.identity === target);
    if (!p) throw notFound('Participante não está na sala');
    if (isSelf(p.identity) && action !== 'mute') throw badRequest('Você não pode fazer isso com você mesmo');
    if (!who.organizer && action === 'remove' && p.role === 'moderator')
      throw forbidden('Só o organizador da sala pode remover um moderador');
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
    actorId: who.userId,
    action: `moderation.${action}`,
    target: target ? `${room.slug}:${target}` : room.slug,
    // A promoted guest has no account: the log keeps who they were in the meeting.
    meta: who.userId ? { affected } : { affected, by: who.name, identity: who.identity ?? '' },
    ip,
  });
  return { affected };
}
