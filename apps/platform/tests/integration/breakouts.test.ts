import { AccessToken, TokenVerifier } from 'livekit-server-sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signup } from '@/server/auth/service';
import type { SessionUser } from '@/server/auth/session';
import {
  closeBreakouts,
  currentBreakouts,
  openBreakouts,
  openBreakoutsInput,
  switchRoom,
  switchRoomInput,
} from '@/server/breakouts/service';
import type { Sql } from '@/server/db';
import { AppError } from '@/server/errors';
import type { LiveKitAdmin } from '@/server/livekit-admin';
import { grantJoin } from '@/server/rooms/join';
import { createRoom } from '@/server/rooms/service';
import { hashPassword } from '@/server/security/password';
import { agentInput, createRoomInput } from '@/server/validation';
import { type TestSql, freshDatabase } from './db';
import { agentChoices } from './ready-agent';
import { listAgents, updateAgent } from '@/server/agents/service';

let sql: TestSql;
const db = () => sql as unknown as Sql;
const PASSWORD = 'senha-muito-segura';
const cfg = {
  livekitUrl: 'wss://lk.test',
  livekitApiKey: 'APIkey',
  livekitApiSecret: 'a-very-long-livekit-secret-for-tests-0123456789',
  agentName: 'kaiser',
};

class FakeLiveKit implements LiveKitAdmin {
  sent: string[] = [];
  async listParticipants() {
    return [];
  }
  async listRooms() {
    return [];
  }
  async muteAudio() {}
  async remove() {}
  async setRole() {}
  async setAttributes() {}
  async dispatchAgent() {}
  async sendData(room: string, payload: string, topic: string) {
    this.sent.push(`${room} ${topic} ${payload}`);
  }
}

async function expectAppError(promise: Promise<unknown>, status: number) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).status).toBe(status);
}

const claimsOf = (token: string) => new TokenVerifier(cfg.livekitApiKey, cfg.livekitApiSecret).verify(token);

async function setup() {
  const { tenant, user: admin } = await signup(
    db(),
    { organization: 'Acme', slug: 'acme', name: 'Admin', email: 'admin@acme.test', password: PASSWORD },
    null,
    'enterprise',
  );
  const [member] = await sql<SessionUser[]>`
    insert into users (tenant_id, email, name, password_hash, role)
    values (${tenant.id}, 'bia@acme.test', 'Bia', ${await hashPassword(PASSWORD)}, 'member')
    returning id, tenant_id as "tenantId", email, name, role, is_superadmin as "isSuperadmin"`;
  const [kaiser] = await listAgents(db(), admin);
  const choices = await agentChoices(db(), admin);
  await updateAgent(
    db(),
    admin,
    kaiser.id,
    agentInput.parse({ name: 'Kaiser', instructions: 'x', ...choices }),
    null,
  );
  const room = await createRoom(
    db(),
    admin,
    createRoomInput.parse({ name: 'Aula', agentEnabled: true }),
    null,
  );
  const other = await createRoom(db(), admin, createRoomInput.parse({ name: 'Outra' }), null);
  return { tenant, admin, member, room, other, lk: new FakeLiveKit() };
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

describe('breakout rooms', () => {
  it('moderators open rooms, announce assignments and close them everywhere', async () => {
    const { tenant, admin, member, room, lk } = await setup();
    const input = openBreakoutsInput.parse({ count: 2, assignments: { 'g-1': 1, 'g-2': 2 } });
    await expectAppError(openBreakouts(db(), lk, room, member, input, null), 403);
    await expectAppError(
      openBreakouts(db(), lk, room, admin, { count: 2, assignments: { x: 3 } }, null),
      400,
    );

    await openBreakouts(db(), lk, room, admin, input, null);
    expect(await currentBreakouts(db(), room)).toEqual({ count: 2, assignments: { 'g-1': 1, 'g-2': 2 } });
    const main = `${tenant.id}.${room.slug}`;
    expect(lk.sent).toEqual([
      `${main} impa-breakout {"type":"open","count":2,"assignments":{"g-1":1,"g-2":2}}`,
    ]);

    await closeBreakouts(db(), lk, room, admin, null);
    expect(lk.sent.slice(1)).toEqual(
      [0, 1, 2].map((n) => `${n ? `${main}~${n}` : main} impa-breakout {"type":"close"}`),
    );
    expect(await currentBreakouts(db(), room)).toBeNull();
    await expectAppError(closeBreakouts(db(), lk, room, admin, null), 404);
  });

  it('trades an admitted participant token for one to a breakout room and back', async () => {
    const { tenant, admin, room, lk } = await setup();
    const guest = await grantJoin(db(), cfg, room, {
      identity: 'g-1',
      displayName: 'Convidado',
      role: 'guest',
    });
    await expectAppError(
      switchRoom(db(), cfg, room, switchRoomInput.parse({ token: guest.token, target: 1 })),
      404,
    );

    await openBreakouts(db(), lk, room, admin, { count: 3, assignments: {} }, null);
    const inBreakout = await switchRoom(
      db(),
      cfg,
      room,
      switchRoomInput.parse({ token: guest.token, target: 2 }),
    );
    const claims = await claimsOf(inBreakout.token);
    expect(claims.video?.room).toBe(`${tenant.id}.${room.slug}~2`);
    expect(claims.sub).toBe('g-1');
    expect(claims.name).toBe('Convidado');
    expect(claims.attributes?.role).toBe('guest');
    expect(claims.roomConfig?.agents ?? []).toHaveLength(0);
    expect(inBreakout.roomName).toBe('Aula · Sala 2');
    await expectAppError(
      switchRoom(db(), cfg, room, switchRoomInput.parse({ token: guest.token, target: 4 })),
      404,
    );

    const back = await switchRoom(
      db(),
      cfg,
      room,
      switchRoomInput.parse({ token: inBreakout.token, target: 0 }),
    );
    const mainClaims = await claimsOf(back.token);
    expect(mainClaims.video?.room).toBe(`${tenant.id}.${room.slug}`);
    expect(mainClaims.roomConfig?.agents?.[0]?.agentName).toBe('kaiser');
  });

  it('refuses tokens from other rooms or signed with another secret', async () => {
    const { admin, room, other, lk } = await setup();
    await openBreakouts(db(), lk, room, admin, { count: 2, assignments: {} }, null);
    const elsewhere = await grantJoin(db(), cfg, other, { identity: 'g-9', displayName: 'X', role: 'guest' });
    await expectAppError(switchRoom(db(), cfg, room, { token: elsewhere.token, target: 1 }), 403);

    const forged = new AccessToken(cfg.livekitApiKey, 'another-secret-that-is-long-enough-0123456789', {
      identity: 'g-1',
    });
    forged.addGrant({ roomJoin: true, room: `${room.tenantId}.${room.slug}` });
    await expectAppError(switchRoom(db(), cfg, room, { token: await forged.toJwt(), target: 1 }), 403);
    await expectAppError(switchRoom(db(), cfg, room, { token: 'x'.repeat(30), target: 1 }), 403);
  });
});
