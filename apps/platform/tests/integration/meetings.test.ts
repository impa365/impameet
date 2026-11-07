import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signup } from '@/server/auth/service';
import type { SessionUser } from '@/server/auth/session';
import type { Sql } from '@/server/db';
import { AppError } from '@/server/errors';
import { cancelMeeting, createMeeting, findVisibleMeeting, listMeetings } from '@/server/meetings/service';
import { createRoom } from '@/server/rooms/service';
import { hashPassword } from '@/server/security/password';
import { createRoomInput, meetingInput } from '@/server/validation';
import { type TestSql, freshDatabase } from './db';

let sql: TestSql;
const db = () => sql as unknown as Sql;
const NOW = new Date('2026-11-05T12:00:00Z');
const M = (input: Record<string, unknown>) =>
  meetingInput.parse({ title: 'Planejamento', startsAt: '2026-11-10T13:00:00Z', ...input });

async function expectAppError(promise: Promise<unknown>, status: number) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).status).toBe(status);
}

async function member(tenantId: string, email: string): Promise<SessionUser> {
  const [u] = await sql<SessionUser[]>`
    insert into users (tenant_id, email, name, password_hash, role)
    values (${tenantId}, ${email}, ${email.split('@')[0]}, ${await hashPassword('senha-muito-segura')}, 'member')
    returning id, tenant_id as "tenantId", email, name, role, is_superadmin as "isSuperadmin"`;
  return u;
}

async function setup() {
  const { tenant, user: admin } = await signup(
    db(),
    {
      organization: 'Acme',
      slug: 'acme',
      name: 'Admin',
      email: 'admin@acme.test',
      password: 'senha-muito-segura',
    },
    null,
    'enterprise',
  );
  const bia = await member(tenant.id, 'bia@acme.test');
  const caio = await member(tenant.id, 'caio@acme.test');
  const room = await createRoom(db(), bia, createRoomInput.parse({ name: 'Vendas' }), null);
  return { tenant, admin, bia, caio, room };
}

beforeAll(async () => {
  sql = await freshDatabase();
});
afterAll(async () => {
  await sql?.end({ timeout: 5 });
});
beforeEach(async () => {
  await sql`truncate tenants, audit_log restart identity cascade`;
});

describe('scheduled meetings', () => {
  it('room owners schedule meetings with invitees; duplicates are dropped', async () => {
    const { bia, room } = await setup();
    const meeting = await createMeeting(
      db(),
      bia,
      M({ roomSlug: room.slug, invitees: ['Ana@X.test', 'ana@x.test', 'felipe@x.test'], durationMin: 45 }),
      null,
      NOW,
    );
    expect(meeting).toMatchObject({
      roomSlug: room.slug,
      roomName: 'Vendas',
      title: 'Planejamento',
      durationMin: 45,
      invitees: ['ana@x.test', 'felipe@x.test'],
      createdByName: 'bia',
      createdByEmail: 'bia@acme.test',
    });
    expect(meeting.startsAt.toISOString()).toBe('2026-11-10T13:00:00.000Z');
    const [log] = await sql<{ action: string }[]>`select action from audit_log where action like 'meeting.%'`;
    expect(log.action).toBe('meeting.scheduled');
  });

  it('refuses other people’s rooms, unknown rooms and past dates', async () => {
    const { admin, caio, room } = await setup();
    await expectAppError(createMeeting(db(), caio, M({ roomSlug: room.slug }), null, NOW), 403);
    await expectAppError(createMeeting(db(), caio, M({ roomSlug: 'nao-existe' }), null, NOW), 404);
    await expectAppError(
      createMeeting(db(), admin, M({ roomSlug: room.slug, startsAt: '2026-11-01T10:00:00Z' }), null, NOW),
      400,
    );
    expect(() => M({ roomSlug: room.slug, invitees: ['não é email'] })).toThrow();
    expect((await createMeeting(db(), admin, M({ roomSlug: room.slug }), null, NOW)).createdByName).toBe(
      'Admin',
    );
  });

  it('lists upcoming meetings to the right people and lets them cancel', async () => {
    const { admin, bia, caio, room } = await setup();
    const soon = await createMeeting(
      db(),
      bia,
      M({ roomSlug: room.slug, startsAt: '2026-11-06T09:00:00Z' }),
      null,
      NOW,
    );
    const later = await createMeeting(db(), admin, M({ roomSlug: room.slug }), null, NOW);

    expect((await listMeetings(db(), bia, NOW)).map((m) => m.id)).toEqual([soon.id, later.id]);
    expect((await listMeetings(db(), admin, NOW)).map((m) => m.id)).toEqual([soon.id, later.id]);
    expect(await listMeetings(db(), caio, NOW)).toEqual([]);
    expect(await listMeetings(db(), admin, new Date('2026-11-10T14:30:00Z'))).toEqual([]);
    await expectAppError(findVisibleMeeting(db(), caio, soon.id), 404);

    await expectAppError(cancelMeeting(db(), bia, later.id, null), 403);
    await cancelMeeting(db(), bia, soon.id, null);
    await cancelMeeting(db(), admin, later.id, null);
    expect(await listMeetings(db(), admin, NOW)).toEqual([]);
  });
});
