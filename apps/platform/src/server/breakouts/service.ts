import { TokenVerifier } from 'livekit-server-sdk';
import { z } from 'zod';
import { BREAKOUT_TOPIC, type BreakoutSession } from '@/lib/breakouts';
import { audit } from '../audit';
import type { SessionUser } from '../auth/session';
import type { Config } from '../config';
import type { Sql } from '../db';
import { badRequest, forbidden, notFound } from '../errors';
import type { LiveKitAdmin } from '../livekit-admin';
import { type ParticipantRole, issueJoinToken, livekitRoomName } from '../livekit';
import { canModerate } from '../moderation/service';
import { capParticipants, tenantLimits } from '../plans';
import { type JoinGrant, grantJoin, roomPolicies } from '../rooms/join';
import type { Room } from '../rooms/service';

export const MAX_BREAKOUTS = 10;

export const openBreakoutsInput = z.object({
  count: z.number().int().min(2).max(MAX_BREAKOUTS),
  assignments: z.record(z.string().min(1).max(200), z.number().int().min(1).max(MAX_BREAKOUTS)).default({}),
});

export const switchRoomInput = z.object({
  token: z.string().min(20).max(8192),
  target: z.number().int().min(0).max(MAX_BREAKOUTS),
});

export async function currentBreakouts(sql: Sql, room: Room): Promise<BreakoutSession | null> {
  const [row] = await sql<{ count: number; assignments: Record<string, number> }[]>`
    select room_count as count, assignments from breakout_sessions where room_id = ${room.id}`;
  return row ?? null;
}

async function assertModerator(lk: LiveKitAdmin, room: Room, user: SessionUser | null): Promise<SessionUser> {
  if (!user || !(await canModerate(lk, room, user))) throw forbidden('Só moderadores abrem salas paralelas');
  return user;
}

export async function openBreakouts(
  sql: Sql,
  lk: LiveKitAdmin,
  room: Room,
  user: SessionUser | null,
  input: z.infer<typeof openBreakoutsInput>,
  ip: string | null,
): Promise<BreakoutSession> {
  const actor = await assertModerator(lk, room, user);
  if (Object.values(input.assignments).some((n) => n > input.count)) {
    throw badRequest('Há participantes em uma sala que não existe');
  }
  await sql`
    insert into breakout_sessions (room_id, room_count, assignments, opened_by)
    values (${room.id}, ${input.count}, ${sql.json(input.assignments)}, ${actor.id})
    on conflict (room_id) do update set room_count = excluded.room_count,
      assignments = excluded.assignments, opened_by = excluded.opened_by, opened_at = now()`;
  const session = { count: input.count, assignments: input.assignments };
  await lk.sendData(
    livekitRoomName(room.tenantId, room.slug),
    JSON.stringify({ type: 'open', ...session }),
    BREAKOUT_TOPIC,
  );
  await audit(sql, {
    tenantId: room.tenantId,
    actorId: actor.id,
    action: 'breakouts.opened',
    target: room.slug,
    meta: { count: input.count },
    ip,
  });
  return session;
}

/** Tells every breakout room (and the main one) that the session is over, so clients return. */
export async function closeBreakouts(
  sql: Sql,
  lk: LiveKitAdmin,
  room: Room,
  user: SessionUser | null,
  ip: string | null,
): Promise<void> {
  const actor = await assertModerator(lk, room, user);
  const session = await currentBreakouts(sql, room);
  if (!session) throw notFound('Não há salas paralelas abertas');
  await sql`delete from breakout_sessions where room_id = ${room.id}`;
  const message = JSON.stringify({ type: 'close' });
  for (let n = 0; n <= session.count; n++) {
    await lk.sendData(livekitRoomName(room.tenantId, room.slug, n), message, BREAKOUT_TOPIC);
  }
  await audit(sql, {
    tenantId: room.tenantId,
    actorId: actor.id,
    action: 'breakouts.closed',
    target: room.slug,
    ip,
  });
}

/**
 * Moves a participant between the main room (0) and its breakout rooms. The LiveKit token the
 * participant already holds proves they were admitted (password, lobby, guest rules), so the new
 * token keeps the same identity, name and role.
 */
export async function switchRoom(
  sql: Sql,
  cfg: Pick<Config, 'livekitApiKey' | 'livekitApiSecret' | 'livekitUrl' | 'agentName'>,
  room: Room,
  input: z.infer<typeof switchRoomInput>,
): Promise<JoinGrant> {
  const claims = await new TokenVerifier(cfg.livekitApiKey, cfg.livekitApiSecret)
    .verify(input.token)
    .catch(() => null);
  const current = claims?.video?.room ?? '';
  const main = livekitRoomName(room.tenantId, room.slug);
  if (!claims?.sub || !(current === main || current.startsWith(`${main}~`))) {
    throw forbidden('Entre na reunião antes de trocar de sala');
  }
  const who = {
    identity: claims.sub,
    displayName: claims.name || claims.sub,
    role: (claims.attributes?.role ?? 'guest') as ParticipantRole,
  };
  if (input.target === 0) return grantJoin(sql, cfg, room, who);

  const session = await currentBreakouts(sql, room);
  if (!session || input.target > session.count) throw notFound('Esta sala paralela não está aberta');
  const limits = await tenantLimits(sql, room.tenantId);
  const token = await issueJoinToken({
    apiKey: cfg.livekitApiKey,
    apiSecret: cfg.livekitApiSecret,
    tenantId: room.tenantId,
    roomSlug: room.slug,
    breakout: input.target,
    ...who,
    maxParticipants: capParticipants(room.maxParticipants, limits.maxParticipants),
  });
  return {
    serverUrl: cfg.livekitUrl,
    token,
    role: who.role,
    roomName: `${room.name} · Sala ${input.target}`,
    policies: roomPolicies(room),
  };
}
