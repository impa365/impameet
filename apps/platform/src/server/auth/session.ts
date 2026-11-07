import type { Sql } from '../db';
import { hashToken, newToken } from '../security/tokens';

export const SESSION_COOKIE = 'impa_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 10 * 60 * 1000;

export type UserRole = 'admin' | 'manager' | 'member';

export interface SessionUser {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  role: UserRole;
  isSuperadmin: boolean;
}

export interface SessionMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export async function createSession(
  sql: Sql,
  userId: string,
  meta: SessionMeta,
  now = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = newToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await sql`
    insert into sessions (id_hash, user_id, expires_at, ip, user_agent)
    values (${hashToken(token)}, ${userId}, ${expiresAt}, ${meta.ip ?? null},
            ${meta.userAgent?.slice(0, 300) ?? null})`;
  return { token, expiresAt };
}

/** The signed-in user, only if the session is valid, unexpired and belongs to this tenant. */
export async function findSessionUser(
  sql: Sql,
  token: string | undefined,
  tenantId: string,
): Promise<SessionUser | null> {
  if (!token || token.length > 100) return null;
  const idHash = hashToken(token);
  const [row] = await sql<(SessionUser & { lastSeenAt: Date })[]>`
    select u.id, u.tenant_id as "tenantId", u.email, u.name, u.role,
           u.is_superadmin as "isSuperadmin", s.last_seen_at as "lastSeenAt"
    from sessions s join users u on u.id = s.user_id
    where s.id_hash = ${idHash} and s.expires_at > now()
      and u.status = 'active' and u.tenant_id = ${tenantId}`;
  if (!row) return null;
  if (Date.now() - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await sql`update sessions set last_seen_at = now() where id_hash = ${idHash}`;
  }
  const { lastSeenAt: _ignored, ...user } = row;
  return user;
}

export async function deleteSession(sql: Sql, token: string | undefined): Promise<void> {
  if (!token) return;
  await sql`delete from sessions where id_hash = ${hashToken(token)}`;
}

export async function purgeExpiredSessions(sql: Sql): Promise<number> {
  const result = await sql`delete from sessions where expires_at <= now()`;
  return result.count;
}
