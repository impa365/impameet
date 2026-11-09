import { timingSafeEqual } from 'node:crypto';
import { audit } from '../audit';
import type { SessionUser } from '../auth/session';
import type { Sql } from '../db';
import { notFound } from '../errors';
import type { Room } from '../rooms/service';
import { hashToken, newToken } from '../security/tokens';

/** Data topic on which the server tells a live room that someone is asking to join. */
export const LOBBY_TOPIC = 'impa.lobby';

/** Requests left unanswered this long are treated as refused. */
export const LOBBY_TTL_MINUTES = 30;

export type LobbyStatus = 'pending' | 'approved' | 'denied';

export interface LobbyRequest {
  id: string;
  displayName: string;
  userId: string | null;
  createdAt: Date;
}

export async function requestEntry(
  sql: Sql,
  room: Room,
  user: SessionUser | null,
  displayName: string,
): Promise<{ id: string; secret: string }> {
  const secret = newToken();
  const [row] = await sql<{ id: string }[]>`
    insert into lobby_requests (room_id, secret_hash, display_name, user_id)
    values (${room.id}, ${hashToken(secret)}, ${user?.name ?? displayName}, ${user?.id ?? null})
    returning id`;
  return { id: row.id, secret };
}

/** Status of one request, readable only with the secret given to the requester. */
export async function entryStatus(
  sql: Sql,
  room: Room,
  id: string,
  secret: string,
): Promise<{ status: LobbyStatus; displayName: string; userId: string | null }> {
  const [row] = await sql<
    {
      secretHash: Buffer;
      status: LobbyStatus;
      displayName: string;
      userId: string | null;
      expired: boolean;
    }[]
  >`
    select secret_hash as "secretHash", status, display_name as "displayName", user_id as "userId",
           created_at < now() - make_interval(mins => ${LOBBY_TTL_MINUTES}) as expired
    from lobby_requests where id = ${id} and room_id = ${room.id}`;
  const given = hashToken(secret);
  if (!row || row.secretHash.length !== given.length || !timingSafeEqual(row.secretHash, given)) {
    throw notFound('Pedido de entrada não encontrado');
  }
  const status = row.status === 'pending' && row.expired ? 'denied' : row.status;
  return { status, displayName: row.displayName, userId: row.userId };
}

export async function pendingRequests(sql: Sql, room: Room): Promise<LobbyRequest[]> {
  return sql<LobbyRequest[]>`
    select id, display_name as "displayName", user_id as "userId", created_at as "createdAt"
    from lobby_requests
    where room_id = ${room.id} and status = 'pending'
      and created_at >= now() - make_interval(mins => ${LOBBY_TTL_MINUTES})
    order by created_at limit 100`;
}

/**
 * Caller must already be authorized as a moderator of `room`. `decidedBy` is the moderator's
 * user id (null when an AI agent applied an admin rule); `meta` notes how it was decided.
 */
export async function decide(
  sql: Sql,
  room: Room,
  decidedBy: string | null,
  id: string,
  approve: boolean,
  ip: string | null,
  meta?: Record<string, string>,
): Promise<void> {
  const result = await sql`
    update lobby_requests set status = ${approve ? 'approved' : 'denied'},
           decided_by = ${decidedBy}, decided_at = now()
    where id = ${id} and room_id = ${room.id} and status = 'pending'`;
  if (result.count === 0) throw notFound('Pedido já respondido ou inexistente');
  await audit(sql, {
    tenantId: room.tenantId,
    actorId: decidedBy,
    action: approve ? 'lobby.approved' : 'lobby.denied',
    target: room.slug,
    meta,
    ip,
  });
}
