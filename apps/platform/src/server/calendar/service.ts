import { audit } from '../audit';
import type { SessionUser } from '../auth/session';
import type { Sql } from '../db';
import { badRequest, notFound, tooManyRequests } from '../errors';
import { RateLimiter } from '../security/rate-limit';
import { openSecret, sealSecret } from '../security/secrets';
import { GoogleError, accessToken, authUrl, exchangeCode, oauthStart, revoke } from '../storage/google';
import {
  STATE_TTL_MS,
  type StorageDeps,
  googleClient,
  needKey,
  platformGoogleRow,
  stateAad,
} from '../storage/service';
import {
  CALENDAR_SCOPE,
  CALENDAR_SCOPES,
  type CalendarEvent,
  deleteEvent,
  insertEvent,
} from './google-calendar';

export type CalendarDeps = StorageDeps;

const calendarAad = (userId: string) => `calendar:${userId}`;
const connects = new RateLimiter(10, 10 * 60_000);

interface Connection {
  userId: string;
  tenantId: string;
  googleEmail: string | null;
  sealed: string;
  createdAt: Date;
}

async function connection(sql: Sql, userId: string): Promise<Connection | null> {
  const [row] = await sql<Connection[]>`
    select user_id as "userId", tenant_id as "tenantId", google_email as "googleEmail",
           secret_sealed as sealed, created_at as "createdAt"
    from user_calendars where user_id = ${userId}`;
  return row ?? null;
}

export interface CalendarView {
  /** The super admin configured Google: the calendar can be connected. */
  available: boolean;
  encryption: boolean;
  connected: { email: string | null; since: Date } | null;
}

/** The person's own Google Calendar connection (never the token). */
export async function getCalendar(deps: CalendarDeps, user: SessionUser): Promise<CalendarView> {
  const row = await connection(deps.sql, user.id);
  return {
    available: Boolean(await platformGoogleRow(deps.sql)),
    encryption: deps.key !== null,
    connected: row ? { email: row.googleEmail, since: row.createdAt } : null,
  };
}

/** "Conectar Google Agenda": a one-time state bound to this person, with a PKCE verifier. */
export async function startCalendar(
  deps: CalendarDeps,
  user: SessionUser,
  returnUrl: string,
): Promise<{ url: string }> {
  if (!connects.take(user.id)) throw tooManyRequests();
  const key = needKey(deps);
  const client = await googleClient(deps);
  if (!client) throw badRequest('O super admin ainda não configurou o Google nesta plataforma');
  const { state, verifier, challenge } = oauthStart();
  await deps.sql`delete from oauth_states where created_at < now() - make_interval(secs => ${STATE_TTL_MS / 1000})`;
  await deps.sql`
    insert into oauth_states (id, tenant_id, user_id, purpose, verifier_sealed, return_url, keep_local)
    values (${state}, ${user.tenantId}, ${user.id}, 'calendar', ${sealSecret(key, verifier, stateAad(state))},
            ${returnUrl}, false)`;
  return { url: authUrl(client, state, challenge, CALENDAR_SCOPES) };
}

const withStatus = (url: string, status: string) => {
  const u = new URL(url);
  u.searchParams.set('calendar', status);
  return u.toString();
};

/** Google sends the person back here: the one-time state is used up, the calendar saved. */
export async function finishCalendar(
  deps: CalendarDeps,
  params: { state: string | null; code: string | null; error: string | null },
  ip: string | null,
): Promise<string> {
  const key = needKey(deps);
  if (!params.state || params.state.length > 100) throw badRequest('Conexão inválida ou expirada');
  const [row] = await deps.sql<
    { tenantId: string; userId: string; verifierSealed: string; returnUrl: string; createdAt: Date }[]
  >`
    delete from oauth_states where id = ${params.state} and purpose = 'calendar'
    returning tenant_id as "tenantId", user_id as "userId", verifier_sealed as "verifierSealed",
              return_url as "returnUrl", created_at as "createdAt"`;
  if (!row || Date.now() - new Date(row.createdAt).getTime() > STATE_TTL_MS)
    throw badRequest('Conexão inválida ou expirada; comece de novo');
  if (params.error || !params.code) return withStatus(row.returnUrl, 'cancelled');
  const [person] = await deps.sql<{ ok: boolean }[]>`
    select true as ok from users where id = ${row.userId} and tenant_id = ${row.tenantId}`;
  const client = await googleClient(deps);
  if (!person || !client) return withStatus(row.returnUrl, 'error');
  const fetchImpl = deps.fetch ?? fetch;
  try {
    const verifier = openSecret(key, row.verifierSealed, stateAad(params.state));
    const granted = await exchangeCode(fetchImpl, client, params.code, verifier);
    if (!granted.scopes.includes(CALENDAR_SCOPE)) {
      await revoke(fetchImpl, granted.refreshToken);
      return withStatus(row.returnUrl, 'scope');
    }
    const previous = await connection(deps.sql, row.userId);
    if (previous) await forget(deps, previous, key);
    await deps.sql`
      insert into user_calendars (user_id, tenant_id, google_email, secret_sealed)
      values (${row.userId}, ${row.tenantId}, ${granted.email},
              ${sealSecret(key, granted.refreshToken, calendarAad(row.userId))})
      on conflict (user_id) do update set google_email = excluded.google_email,
        secret_sealed = excluded.secret_sealed, created_at = now()`;
    await audit(deps.sql, {
      tenantId: row.tenantId,
      actorId: row.userId,
      action: 'calendar.connected',
      target: 'google',
      meta: { account: granted.email ?? '' },
      ip,
    });
    return withStatus(row.returnUrl, 'connected');
  } catch {
    return withStatus(row.returnUrl, 'error');
  }
}

async function forget(deps: CalendarDeps, row: Connection, key: Buffer): Promise<void> {
  try {
    await revoke(deps.fetch ?? fetch, openSecret(key, row.sealed, calendarAad(row.userId)));
  } catch {
    // The stored token goes away either way.
  }
}

/** Disconnects: the access is also revoked at Google. Events already created stay there. */
export async function disconnectCalendar(
  deps: CalendarDeps,
  user: SessionUser,
  ip: string | null,
): Promise<void> {
  const row = await connection(deps.sql, user.id);
  if (!row) throw notFound('Nenhum Google Agenda conectado');
  if (deps.key) await forget(deps, row, deps.key);
  await deps.sql`delete from user_calendars where user_id = ${user.id}`;
  await audit(deps.sql, {
    tenantId: user.tenantId,
    actorId: user.id,
    action: 'calendar.disconnected',
    target: 'google',
    ip,
  });
}

async function tokenFor(deps: CalendarDeps, row: Connection, key: Buffer): Promise<string> {
  const client = await googleClient(deps);
  if (!client) throw new GoogleError('O Google não está configurado nesta plataforma');
  return accessToken(deps.fetch ?? fetch, client, openSecret(key, row.sealed, calendarAad(row.userId)));
}

export type CalendarSync = { status: 'off' } | { status: 'synced' } | { status: 'failed'; error: string };

/**
 * Puts a newly scheduled meeting in its organizer's Google Calendar, when connected. Never fails
 * the scheduling: a problem is kept on the meeting and told to the person.
 */
export async function addMeetingEvent(
  deps: CalendarDeps,
  user: SessionUser,
  meetingId: string,
  event: CalendarEvent,
): Promise<CalendarSync> {
  const row = await connection(deps.sql, user.id);
  if (!row || !deps.key) return { status: 'off' };
  try {
    const eventId = await insertEvent(deps.fetch ?? fetch, await tokenFor(deps, row, deps.key), event);
    await deps.sql`
      update meetings set google_event_id = ${eventId}, google_user_id = ${user.id}, google_error = null
      where id = ${meetingId}`;
    return { status: 'synced' };
  } catch (err) {
    const error = (
      err instanceof GoogleError ? err.message : 'Não foi possível falar com o Google Agenda agora'
    ).slice(0, 500);
    await deps.sql`update meetings set google_error = ${error} where id = ${meetingId}`;
    return { status: 'failed', error };
  }
}

/** Cancels a cancelled meeting's Google Calendar event (best effort: Google then tells the guests). */
export async function removeMeetingEvent(
  deps: CalendarDeps,
  link: { googleEventId: string | null; googleUserId: string | null },
): Promise<boolean> {
  if (!link.googleEventId || !link.googleUserId || !deps.key) return false;
  const row = await connection(deps.sql, link.googleUserId);
  if (!row) return false;
  try {
    await deleteEvent(deps.fetch ?? fetch, await tokenFor(deps, row, deps.key), link.googleEventId);
    return true;
  } catch {
    return false;
  }
}
