import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signup } from '@/server/auth/service';
import type { SessionUser } from '@/server/auth/session';
import {
  addMeetingEvent,
  disconnectCalendar,
  finishCalendar,
  getCalendar,
  removeMeetingEvent,
  startCalendar,
} from '@/server/calendar/service';
import type { Sql } from '@/server/db';
import { AppError } from '@/server/errors';
import { cancelMeeting, createMeeting, listMeetings } from '@/server/meetings/service';
import { createRoom } from '@/server/rooms/service';
import { hashPassword } from '@/server/security/password';
import type { Fetch } from '@/server/storage/google';
import { type StorageDeps, oauthPurpose, savePlatformGoogle } from '@/server/storage/service';
import { createRoomInput, meetingInput, platformGoogleInput } from '@/server/validation';
import { type TestSql, freshDatabase } from './db';
import { READY_AGENT_KEY } from './ready-agent';

let sql: TestSql;
const db = () => sql as unknown as Sql;
const PASSWORD = 'senha-muito-segura';
const EVENTS = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

/** Google's token endpoints and the Calendar events calls. */
function fakeGoogle(opts: { scope?: string; failInsert?: boolean } = {}) {
  const calls: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const idToken = `x.${Buffer.from(JSON.stringify({ email: 'ana@acme.com', email_verified: true })).toString('base64url')}.y`;
  const fn = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.replace(EVENTS, 'events')}`);
    if (url === 'https://oauth2.googleapis.com/token') {
      const body = new URLSearchParams(String(init?.body));
      if (body.get('grant_type') === 'authorization_code')
        return Response.json({
          refresh_token: 'cal-refresh-0123456789',
          access_token: 'access-1',
          id_token: idToken,
          scope: opts.scope ?? 'openid https://www.googleapis.com/auth/calendar.events',
        });
      return Response.json({ access_token: 'access-2' });
    }
    if (url === 'https://oauth2.googleapis.com/revoke') return new Response('{}');
    if (url === `${EVENTS}?sendUpdates=all` && method === 'POST') {
      if (opts.failInsert)
        return Response.json({ error: { message: 'Calendar usage limits exceeded.' } }, { status: 403 });
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ id: 'evt-1' });
    }
    if (url.startsWith(`${EVENTS}/evt-1?sendUpdates=all`) && method === 'DELETE')
      return new Response(null, { status: 204 });
    if (url.startsWith(`${EVENTS}/gone`) && method === 'DELETE') return new Response(null, { status: 410 });
    return new Response('{}', { status: 404 });
  }) as unknown as Fetch;
  return { fn, calls, bodies };
}

async function expectAppError(promise: Promise<unknown>, status: number) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).status).toBe(status);
}

async function setup(google = fakeGoogle()) {
  const { tenant, user: admin } = await signup(
    db(),
    { organization: 'Acme', slug: 'acme', name: 'Ana', email: 'ana@acme.test', password: PASSWORD },
    null,
    'enterprise',
  );
  const [member] = await sql<SessionUser[]>`
    insert into users (tenant_id, email, name, password_hash, role)
    values (${tenant.id}, 'bia@acme.test', 'Bia', ${await hashPassword(PASSWORD)}, 'member')
    returning id, tenant_id as "tenantId", email, name, role, is_superadmin as "isSuperadmin"`;
  const deps: StorageDeps = {
    sql: db(),
    key: READY_AGENT_KEY,
    recordingsDir: null,
    platformUrl: 'https://meet.example.com',
    fetch: google.fn,
  };
  await savePlatformGoogle(
    deps,
    { ...admin, isSuperadmin: true },
    platformGoogleInput.parse({
      clientId: '123456789012-abcdefghij0123456789.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-secret_0123456789',
    }),
    null,
  );
  const room = await createRoom(db(), admin, createRoomInput.parse({ name: 'Vendas' }), null);
  return { admin, member, room, deps, google };
}

async function connect(deps: StorageDeps, user: SessionUser) {
  const { url } = await startCalendar(deps, user, 'https://acme.example/account');
  const params = new URL(url).searchParams;
  expect(params.get('scope')).toContain('https://www.googleapis.com/auth/calendar.events');
  expect(params.get('scope')).not.toContain('youtube');
  const state = params.get('state');
  expect(await oauthPurpose(db(), state)).toBe('calendar');
  return finishCalendar(deps, { state, code: 'code-1', error: null }, '10.0.0.1');
}

const meeting = (roomSlug: string) =>
  meetingInput.parse({
    roomSlug,
    title: 'Planejamento',
    description: 'Pauta do trimestre',
    startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    durationMin: 45,
    invitees: ['cliente@empresa.com'],
  });

beforeAll(async () => {
  sql = await freshDatabase();
});
afterAll(async () => {
  await sql?.end({ timeout: 5 });
});
beforeEach(async () => {
  await sql`truncate tenants, audit_log, platform_google restart identity cascade`;
});

describe('Google Calendar', () => {
  it('each person connects their own calendar, sealed, and can disconnect', async () => {
    const { admin, member, deps, google } = await setup();
    expect(await getCalendar(deps, admin)).toEqual({ available: true, encryption: true, connected: null });
    expect(await connect(deps, admin)).toBe('https://acme.example/account?calendar=connected');
    expect((await getCalendar(deps, admin)).connected).toMatchObject({ email: 'ana@acme.com' });
    // Bia's calendar is hers: Ana's connection is not shared.
    expect((await getCalendar(deps, member)).connected).toBeNull();
    const [row] = await sql<{ secret_sealed: string }[]>`select secret_sealed from user_calendars`;
    expect(row.secret_sealed).not.toContain('cal-refresh');

    // Connecting again replaces (and revokes) the previous access.
    await connect(deps, admin);
    expect(google.calls.filter((c) => c.includes('/revoke'))).toHaveLength(1);
    expect(await sql`select 1 from user_calendars`).toHaveLength(1);

    await disconnectCalendar(deps, admin, null);
    expect(google.calls.filter((c) => c.includes('/revoke'))).toHaveLength(2);
    expect((await getCalendar(deps, admin)).connected).toBeNull();
    await expectAppError(disconnectCalendar(deps, admin, null), 404);
    const actions = await sql<
      { action: string }[]
    >`select action from audit_log where action like 'calendar.%' order by id`;
    expect(actions.map((a) => a.action)).toEqual([
      'calendar.connected',
      'calendar.connected',
      'calendar.disconnected',
    ]);
  });

  it('refuses a missing permission, a cancelled consent and a used or unknown state', async () => {
    const { admin, deps } = await setup();
    expect(await connect({ ...deps, fetch: fakeGoogle({ scope: 'openid email' }).fn }, admin)).toContain(
      'calendar=scope',
    );
    const { url } = await startCalendar(deps, admin, 'https://acme.example/account');
    const state = new URL(url).searchParams.get('state');
    expect(await finishCalendar(deps, { state, code: null, error: 'access_denied' }, null)).toContain(
      'calendar=cancelled',
    );
    await expectAppError(finishCalendar(deps, { state, code: 'c', error: null }, null), 400);
    await expectAppError(finishCalendar(deps, { state: null, code: 'c', error: null }, null), 400);
    expect((await getCalendar(deps, admin)).connected).toBeNull();
    await sql`delete from platform_google`;
    await expectAppError(startCalendar(deps, admin, 'https://acme.example/account'), 400);
  });

  it('puts a scheduled meeting in the organizer’s calendar and cancels it there too', async () => {
    const { admin, room, deps, google } = await setup();
    const event = (m: Awaited<ReturnType<typeof createMeeting>>) => ({
      title: m.title,
      description: m.description,
      start: m.startsAt,
      durationMin: m.durationMin,
      url: `https://acme.example/r/${room.slug}`,
      attendees: m.invitees,
      productName: 'IMPA Meet',
    });

    // Not connected: nothing happens at Google.
    const plain = await createMeeting(db(), admin, meeting(room.slug), null);
    expect(await addMeetingEvent(deps, admin, plain.id, event(plain))).toEqual({ status: 'off' });

    await connect(deps, admin);
    const m = await createMeeting(db(), admin, meeting(room.slug), null);
    expect(await addMeetingEvent(deps, admin, m.id, event(m))).toEqual({ status: 'synced' });
    expect(google.bodies[0]).toMatchObject({
      summary: 'Planejamento',
      location: `https://acme.example/r/${room.slug}`,
      attendees: [{ email: 'cliente@empresa.com' }],
      description: `Pauta do trimestre\n\nIMPA Meet: https://acme.example/r/${room.slug}`,
      guestsCanModify: false,
    });
    const start = new Date((google.bodies[0].start as { dateTime: string }).dateTime);
    const end = new Date((google.bodies[0].end as { dateTime: string }).dateTime);
    expect(end.getTime() - start.getTime()).toBe(45 * 60_000);
    const listed = await listMeetings(db(), admin);
    expect(listed.find((x) => x.id === m.id)).toMatchObject({ inGoogleCalendar: true, googleError: null });
    expect(listed.find((x) => x.id === plain.id)).toMatchObject({ inGoogleCalendar: false });

    const link = await cancelMeeting(db(), admin, m.id, null);
    expect(link).toEqual({ googleEventId: 'evt-1', googleUserId: admin.id });
    expect(await removeMeetingEvent(deps, link)).toBe(true);
    expect(google.calls).toContain('DELETE events/evt-1?sendUpdates=all');
    // Already gone at Google, or never there: nothing to do.
    expect(await removeMeetingEvent(deps, { googleEventId: 'gone', googleUserId: admin.id })).toBe(true);
    expect(await removeMeetingEvent(deps, await cancelMeeting(db(), admin, plain.id, null))).toBe(false);
    expect(
      await removeMeetingEvent({ ...deps, key: null }, { googleEventId: 'evt-1', googleUserId: admin.id }),
    ).toBe(false);
  });

  it('never fails the scheduling: a Google problem is kept on the meeting', async () => {
    const { admin, room, deps } = await setup();
    await connect(deps, admin);
    const m = await createMeeting(db(), admin, meeting(room.slug), null);
    const failing = { ...deps, fetch: fakeGoogle({ failInsert: true }).fn };
    const sync = await addMeetingEvent(failing, admin, m.id, {
      title: m.title,
      description: '',
      start: m.startsAt,
      durationMin: m.durationMin,
      url: 'https://acme.example/r/x',
      attendees: [],
      productName: 'IMPA Meet',
    });
    expect(sync).toEqual({
      status: 'failed',
      error: 'O Google Agenda recusou o evento: Calendar usage limits exceeded.',
    });
    expect((await listMeetings(db(), admin)).find((x) => x.id === m.id)).toMatchObject({
      inGoogleCalendar: false,
      googleError: 'O Google Agenda recusou o evento: Calendar usage limits exceeded.',
    });
    // Without the encryption key nothing is attempted.
    expect(
      await addMeetingEvent({ ...deps, key: null }, admin, m.id, { ...sync, title: 'x' } as never),
    ).toEqual({
      status: 'off',
    });
  });
});
