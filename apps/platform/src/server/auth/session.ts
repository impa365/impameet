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
  /** The organization requires two-step verification and this user has no method yet. */
  mfaSetupRequired?: boolean;
}

export interface SessionMeta {
  ip?: string | null;
  userAgent?: string | null;
  /** How the second step was done, when there was one. */
  mfaMethod?: string | null;
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
    insert into sessions (id_hash, user_id, expires_at, ip, user_agent, mfa_at, mfa_method)
    values (${hashToken(token)}, ${userId}, ${expiresAt}, ${meta.ip ?? null},
            ${meta.userAgent?.slice(0, 300) ?? null}, ${meta.mfaMethod ? now : null}, ${meta.mfaMethod ?? null})`;
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
           u.is_superadmin as "isSuperadmin", s.last_seen_at as "lastSeenAt",
           (t.require_mfa and not exists (
              select 1 from user_mfa m where m.user_id = u.id
                and (m.totp_enabled_at is not null or m.email_enabled_at is not null))
            and not exists (select 1 from webauthn_credentials w where w.user_id = u.id)) as "mfaSetupRequired"
    from sessions s join users u on u.id = s.user_id join tenants t on t.id = u.tenant_id
    where s.id_hash = ${idHash} and s.expires_at > now()
      and u.status = 'active' and u.tenant_id = ${tenantId}`;
  if (!row) return null;
  if (Date.now() - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await sql`update sessions set last_seen_at = now() where id_hash = ${idHash}`;
  }
  const { lastSeenAt: _ignored, ...user } = row;
  return user;
}

export interface SessionInfo {
  /** A short, stable handle (never the token, nor enough of its hash to matter). */
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  mfaMethod: string | null;
  current: boolean;
}

export async function listSessions(
  sql: Sql,
  userId: string,
  token: string | undefined,
): Promise<SessionInfo[]> {
  const mine = token ? hashToken(token) : null;
  const rows = await sql<(Omit<SessionInfo, 'current'> & { idHash: Buffer })[]>`
    select id_hash as "idHash", encode(substring(id_hash from 1 for 8), 'hex') as id, ip, user_agent as "userAgent",
           created_at as "createdAt", last_seen_at as "lastSeenAt", mfa_method as "mfaMethod"
    from sessions where user_id = ${userId} and expires_at > now() order by last_seen_at desc limit 50`;
  return rows.map(({ idHash, ...s }) => ({ ...s, current: Boolean(mine?.equals(idHash)) }));
}

/** Signs a device out: one session by its handle, or every other one ("others"). */
export async function revokeSessions(
  sql: Sql,
  userId: string,
  which: string,
  token: string | undefined,
): Promise<number> {
  const mine = token ? hashToken(token) : Buffer.alloc(0);
  const result =
    which === 'others'
      ? await sql`delete from sessions where user_id = ${userId} and id_hash <> ${mine}`
      : await sql`delete from sessions where user_id = ${userId} and id_hash <> ${mine}
                  and encode(substring(id_hash from 1 for 8), 'hex') = ${which}`;
  return result.count;
}

export async function deleteSession(sql: Sql, token: string | undefined): Promise<void> {
  if (!token) return;
  await sql`delete from sessions where id_hash = ${hashToken(token)}`;
}

export async function purgeExpiredSessions(sql: Sql): Promise<number> {
  const result = await sql`delete from sessions where expires_at <= now()`;
  return result.count;
}
