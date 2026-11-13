import { AccessToken, TokenVerifier } from 'livekit-server-sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { grantJoin } from '@/server/rooms/join';
import { listAudit, liveRooms, updateBranding } from '@/server/admin/service';
import { signup } from '@/server/auth/service';
import { type SessionUser, createSession, findSessionUser } from '@/server/auth/session';
import type { Sql } from '@/server/db';
import {
  addDomain,
  listDomains,
  removeDomain,
  traefikDynamicConfig,
  verificationRecord,
  verifyDomain,
} from '@/server/domains/service';
import { AppError } from '@/server/errors';
import type { LiveKitAdmin, LiveParticipant } from '@/server/livekit-admin';
import { decide, entryStatus, pendingRequests, requestEntry } from '@/server/lobby/service';
import { agentModerate, agentModerationView, identityUserId } from '@/server/moderation/agent';
import {
  type VerifyToken,
  canModerate,
  listLiveParticipants,
  moderate,
  roomModerator,
  setMeetingControls,
  tokenVerifier,
} from '@/server/moderation/service';
import { tenantLimits } from '@/server/plans';
import {
  type Room,
  createRoom,
  entersDirectly,
  listInvites,
  setInvites,
  updateRoom,
} from '@/server/rooms/service';
import { hashPassword } from '@/server/security/password';
import { listTenants, updateTenant } from '@/server/superadmin/service';
import type { Tenant } from '@/server/tenants/repo';
import { createUser, listUsers, updateUser } from '@/server/users/service';
import { saveStudio, studioState } from '@/server/studio/service';
import {
  agentInput,
  agentModerationInput,
  createRoomInput,
  studioStateInput,
  updateRoomInput,
} from '@/server/validation';
import { EMPTY_STUDIO } from '@/lib/studio';
import { type TestSql, freshDatabase } from './db';
import { agentChoices } from './ready-agent';
import { listAgents, updateAgent } from '@/server/agents/service';

let sql: TestSql;
const db = () => sql as unknown as Sql;
const PASSWORD = 'senha-muito-segura';
const R = (input: Record<string, unknown>) => createRoomInput.parse(input);

class FakeLiveKit implements LiveKitAdmin {
  rooms = new Map<string, LiveParticipant[]>();
  calls: string[] = [];
  participant(identity: string, extra: Partial<LiveParticipant> = {}): LiveParticipant {
    return {
      identity,
      name: identity,
      role: 'participant',
      isAgent: false,
      handRaised: false,
      audioTrackSids: [`TR_${identity}`],
      audioMuted: false,
      joinedAt: 0,
      ...extra,
    };
  }
  async listParticipants(room: string) {
    return this.rooms.get(room) ?? [];
  }
  async listRooms() {
    return [...this.rooms.entries()].map(([name, ps]) => ({ name, participants: ps.length, createdAt: 0 }));
  }
  async muteTrack(room: string, identity: string, sid: string) {
    this.calls.push(`mute ${identity} ${sid}`);
  }
  async remove(room: string, identity: string) {
    this.calls.push(`remove ${identity}`);
  }
  async setRole(room: string, identity: string, role: string) {
    this.calls.push(`role ${identity} ${role}`);
  }
  async setAttributes(room: string, identity: string, attributes: Record<string, string>) {
    this.calls.push(`attributes ${room} ${identity} ${JSON.stringify(attributes)}`);
  }
  async dispatchAgent(room: string, agentName: string, metadata: string) {
    this.calls.push(`dispatch ${agentName} ${metadata}`);
  }
  async sendData(room: string, payload: string, topic: string) {
    this.calls.push(`data ${room} ${topic} ${payload}`);
  }
  async updateRoomMetadata(room: string, metadata: string) {
    this.calls.push(`metadata ${room} ${metadata}`);
  }
}

async function expectAppError(promise: Promise<unknown>, status: number, message?: RegExp) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).status).toBe(status);
  if (message) expect((err as AppError).message).toMatch(message);
}

async function org(slug: string, plan: 'free' | 'pro' | 'enterprise' = 'enterprise') {
  return signup(
    db(),
    { organization: `Org ${slug}`, slug, name: 'Admin', email: `admin@${slug}.test`, password: PASSWORD },
    null,
    plan,
  );
}

async function addUser(tenant: Tenant, email: string, role: SessionUser['role']): Promise<SessionUser> {
  const [u] = await sql<SessionUser[]>`
    insert into users (tenant_id, email, name, password_hash, role)
    values (${tenant.id}, ${email}, ${email.split('@')[0]}, ${await hashPassword(PASSWORD)}, ${role})
    returning id, tenant_id as "tenantId", email, name, role, is_superadmin as "isSuperadmin"`;
  return u;
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

describe('plan limits', () => {
  it('free plans cap rooms and refuse the AI agent; enterprise is unlimited', async () => {
    const { user } = await org('free', 'free');
    expect(await tenantLimits(db(), user.tenantId)).toMatchObject({ maxRooms: 10, agents: false });
    await expectAppError(createRoom(db(), user, R({ name: 'IA', agentEnabled: true }), null), 403, /IA/);
    await sql`update tenants set limits = '{"maxRooms": 1}' where id = ${user.tenantId}`;
    await createRoom(db(), user, R({ name: 'Uma' }), null);
    await expectAppError(createRoom(db(), user, R({ name: 'Duas' }), null), 403, /até 1 salas/);

    const { user: big } = await org('big');
    expect(await tenantLimits(db(), big.tenantId)).toMatchObject({ maxRooms: null, agents: true });
  });
});

describe('join grants', () => {
  const cfg = {
    databaseUrl: 'postgres://x',
    livekitUrl: 'wss://lk.test',
    livekitApiUrl: 'https://lk.test',
    livekitApiKey: 'APIkey',
    livekitApiSecret: 'a-very-long-livekit-secret-for-tests-0123456789',
    platformDomain: 'meet.test',
    agentName: 'kaiser',
    secureCookies: true,
  };

  it('caps participants by plan and drops the agent when the plan lacks it', async () => {
    const { user } = await org('free', 'free');
    const room = await createRoom(db(), user, R({ name: 'Sala', maxParticipants: 50 }), null);
    await sql`update rooms set agent_enabled = true where id = ${room.id}`;
    const fresh = { ...room, agentEnabled: true };
    const grant = await grantJoin(db(), cfg, fresh, { identity: 'g-1', displayName: 'G', role: 'guest' });
    const claims = await new TokenVerifier(cfg.livekitApiKey, cfg.livekitApiSecret).verify(grant.token);
    expect(grant).toMatchObject({ serverUrl: 'wss://lk.test', role: 'guest', roomName: 'Sala' });
    expect(claims.roomConfig?.maxParticipants).toBe(25);
    expect(claims.roomConfig?.agents ?? []).toHaveLength(0);
  });

  it('dispatches the agent on plans that include it, only once it is fully configured', async () => {
    const { user } = await org('big');
    const unready = await createRoom(db(), user, R({ name: 'Sem config', agentEnabled: true }), null);
    const none = await grantJoin(db(), cfg, unready, {
      identity: 'u-0',
      displayName: 'A',
      role: 'moderator',
    });
    expect(
      (await new TokenVerifier(cfg.livekitApiKey, cfg.livekitApiSecret).verify(none.token)).roomConfig
        ?.agents ?? [],
    ).toHaveLength(0);

    const [kaiser] = await listAgents(db(), user);
    const choices = await agentChoices(db(), user);
    await updateAgent(
      db(),
      user,
      kaiser.id,
      agentInput.parse({ name: 'Kaiser', instructions: 'x', ...choices }),
      null,
    );
    const room = await createRoom(db(), user, R({ name: 'IA', agentEnabled: true }), null);
    const grant = await grantJoin(db(), cfg, room, { identity: 'u-1', displayName: 'A', role: 'moderator' });
    const claims = await new TokenVerifier(cfg.livekitApiKey, cfg.livekitApiSecret).verify(grant.token);
    expect(claims.roomConfig?.agents?.[0]?.agentName).toBe('kaiser');
    expect(claims.roomConfig?.maxParticipants ?? 0).toBe(0);
  });
});

describe('room settings', () => {
  it('lets the owner change settings, set and clear the password, and audits it', async () => {
    const { tenant, user: admin } = await org('acme');
    const member = await addUser(tenant, 'bia@acme.test', 'member');
    const other = await addUser(tenant, 'caio@acme.test', 'member');
    const room = await createRoom(db(), member, R({ name: 'Bia' }), null);

    const updated = await updateRoom(
      db(),
      member,
      room.slug,
      { access: 'restricted', password: 'abcd1234', maxParticipants: 8, name: 'Bia 2' },
      null,
    );
    expect(updated).toMatchObject({
      access: 'restricted',
      hasPassword: true,
      maxParticipants: 8,
      name: 'Bia 2',
    });
    const cleared = await updateRoom(db(), admin, room.slug, { password: null, maxParticipants: null }, null);
    expect(cleared).toMatchObject({ hasPassword: false, maxParticipants: null, access: 'restricted' });

    await expectAppError(updateRoom(db(), other, room.slug, { access: 'open' }, null), 403);
    await expectAppError(updateRoom(db(), admin, 'nope', { access: 'open' }, null), 404);
    const [entry] = await sql`select meta from audit_log where action = 'room.updated' order by id limit 1`;
    expect(entry.meta).toMatchObject({ password: 'changed', access: 'restricted' });
  });

  it('refuses turning the agent on when the plan does not include it', async () => {
    const { user } = await org('free', 'free');
    const room = await createRoom(db(), user, R({ name: 'Sala' }), null);
    await expectAppError(updateRoom(db(), user, room.slug, { agentEnabled: true }, null), 403);
  });
});

describe('waiting room', () => {
  let room: Room;
  let admin: SessionUser;
  beforeEach(async () => {
    ({ user: admin } = await org('acme'));
    room = await createRoom(db(), admin, R({ name: 'Espera', access: 'restricted' }), null);
  });

  it('keeps a guest waiting until a moderator approves, behind a secret', async () => {
    const ticket = await requestEntry(db(), room, null, 'Visitante');
    expect(await entryStatus(db(), room, ticket.id, ticket.secret)).toMatchObject({
      status: 'pending',
      displayName: 'Visitante',
      userId: null,
    });
    await expectAppError(entryStatus(db(), room, ticket.id, 'x'.repeat(43)), 404);
    expect((await pendingRequests(db(), room)).map((r) => r.displayName)).toEqual(['Visitante']);

    await decide(db(), room, admin.id, ticket.id, true, null);
    expect((await entryStatus(db(), room, ticket.id, ticket.secret)).status).toBe('approved');
    expect(await pendingRequests(db(), room)).toHaveLength(0);
    await expectAppError(decide(db(), room, admin.id, ticket.id, false, null), 404);
  });

  it('uses the account name for signed-in users and supports denial', async () => {
    const ticket = await requestEntry(db(), room, admin, 'ignored');
    expect((await entryStatus(db(), room, ticket.id, ticket.secret)).displayName).toBe('Admin');
    await decide(db(), room, admin.id, ticket.id, false, null);
    expect((await entryStatus(db(), room, ticket.id, ticket.secret)).status).toBe('denied');
  });

  it('expires unanswered requests', async () => {
    const ticket = await requestEntry(db(), room, null, 'Atrasado');
    await sql`update lobby_requests set created_at = now() - interval '2 hours'`;
    expect((await entryStatus(db(), room, ticket.id, ticket.secret)).status).toBe('denied');
    expect(await pendingRequests(db(), room)).toHaveLength(0);
  });

  it('does not leak requests across rooms', async () => {
    const other = await createRoom(db(), admin, R({ name: 'Outra' }), null);
    const ticket = await requestEntry(db(), room, null, 'V');
    await expectAppError(entryStatus(db(), other, ticket.id, ticket.secret), 404);
    await expectAppError(decide(db(), other, admin.id, ticket.id, true, null), 404);
  });
});

describe('moderation', () => {
  let tenant: Tenant;
  let admin: SessionUser;
  let member: SessionUser;
  let room: Room;
  let lk: FakeLiveKit;
  let lkRoom: string;

  beforeEach(async () => {
    ({ tenant, user: admin } = await org('acme'));
    member = await addUser(tenant, 'bia@acme.test', 'member');
    room = await createRoom(db(), admin, R({ name: 'Mod' }), null);
    lk = new FakeLiveKit();
    lkRoom = `${tenant.id}.${room.slug}`;
    lk.rooms.set(lkRoom, [
      lk.participant(`u-${admin.id}-aaaaaa`, { role: 'moderator' }),
      lk.participant(`u-${member.id}-bbbbbb`),
      lk.participant('g-123456789abc', { role: 'guest' }),
      lk.participant('agent-kaiser', { isAgent: true, audioTrackSids: ['TR_agent'] }),
      lk.participant('g-silent', { role: 'guest', audioTrackSids: [], audioMuted: true }),
    ]);
  });

  it('knows who may moderate', async () => {
    expect(await canModerate(lk, room, admin)).toBe(true);
    expect(await canModerate(lk, room, member)).toBe(false);
    expect(await canModerate(lk, room, null)).toBe(false);
    const { user: foreign } = await org('other');
    expect(await canModerate(lk, room, foreign)).toBe(false);

    lk.rooms.get(lkRoom)![1].role = 'moderator';
    expect(await canModerate(lk, room, member)).toBe(true);
    const listed = await listLiveParticipants(lk, room, member);
    expect(listed).toMatchObject({ canModerate: true });
    expect(listed.participants).toHaveLength(5);
  });

  it('mutes, removes, promotes and demotes, with an audit trail', async () => {
    await moderate(db(), lk, room, admin, 'mute', 'g-123456789abc', '203.0.113.9');
    await moderate(db(), lk, room, admin, 'promote', `u-${member.id}-bbbbbb`, null);
    await moderate(db(), lk, room, admin, 'demote', 'g-123456789abc', null);
    await moderate(db(), lk, room, admin, 'demote', `u-${member.id}-bbbbbb`, null);
    await moderate(db(), lk, room, admin, 'remove', 'g-123456789abc', null);
    expect(lk.calls).toEqual([
      'mute g-123456789abc TR_g-123456789abc',
      `role u-${member.id}-bbbbbb moderator`,
      'role g-123456789abc guest',
      `role u-${member.id}-bbbbbb participant`,
      'remove g-123456789abc',
    ]);
    const actions = await sql`select action from audit_log where action like 'moderation.%' order by id`;
    expect(actions.map((a) => a.action)).toEqual([
      'moderation.mute',
      'moderation.promote',
      'moderation.demote',
      'moderation.demote',
      'moderation.remove',
    ]);
  });

  it('mutes everyone except the moderator and the AI agent', async () => {
    const { affected } = await moderate(db(), lk, room, admin, 'mute_all', undefined, null);
    expect(affected).toBe(2);
    expect(lk.calls).toEqual([
      `mute u-${member.id}-bbbbbb TR_u-${member.id}-bbbbbb`,
      'mute g-123456789abc TR_g-123456789abc',
    ]);
  });

  it('lets a promoted guest moderate this meeting while they are in it; promoting stays with the organizer', async () => {
    const verify: VerifyToken = async (token) =>
      token === 'tok-eva'
        ? { identity: 'g-123456789abc', room: lkRoom, name: 'Eva' }
        : token === 'tok-elsewhere'
          ? { identity: 'g-123456789abc', room: `${tenant.id}.outra`, name: 'Eva' }
          : null;
    const eva = { token: 'tok-eva', verify };
    const people = lk.rooms.get(lkRoom)!;
    // A guest is no moderator until promoted.
    await expectAppError(moderate(db(), lk, room, null, 'mute', `u-${member.id}-bbbbbb`, null, eva), 403);
    people[2].role = 'moderator';
    expect(await listLiveParticipants(lk, room, null, eva)).toMatchObject({
      canModerate: true,
      organizer: false,
    });
    expect(await listLiveParticipants(lk, room, admin)).toMatchObject({ canModerate: true, organizer: true });

    await moderate(db(), lk, room, null, 'mute', `u-${member.id}-bbbbbb`, null, eva);
    const { affected } = await moderate(db(), lk, room, null, 'mute_all', undefined, null, eva);
    expect(affected).toBe(2); // the admin and Bia; never Eva herself nor the agent
    await moderate(db(), lk, room, null, 'remove', 'g-silent', null, eva);
    expect(lk.calls.at(-1)).toBe('remove g-silent');

    // Promoting, demoting and removing a moderator stay with the organizer; never oneself.
    await expectAppError(moderate(db(), lk, room, null, 'promote', `u-${member.id}-bbbbbb`, null, eva), 403);
    await expectAppError(moderate(db(), lk, room, null, 'demote', `u-${admin.id}-aaaaaa`, null, eva), 403);
    await expectAppError(moderate(db(), lk, room, null, 'remove', `u-${admin.id}-aaaaaa`, null, eva), 403);
    await expectAppError(moderate(db(), lk, room, null, 'remove', 'g-123456789abc', null, eva), 400);
    // Another room's token, a forged one or none prove nothing.
    for (const token of ['tok-elsewhere', 'forged', null])
      await expectAppError(
        moderate(db(), lk, room, null, 'mute_all', undefined, null, { token, verify }),
        403,
      );

    // The log keeps who the guest was (no account to point to).
    const [row] = await sql<{ actor_id: string | null; meta: Record<string, unknown> }[]>`
      select actor_id, meta from audit_log where action = 'moderation.remove' order by id desc limit 1`;
    expect(row.actor_id).toBeNull();
    expect(row.meta).toMatchObject({ by: 'g-123456789abc', identity: 'g-123456789abc' });

    // Meeting controls: any moderator of the live meeting, audited, the rest stays the organizer's.
    const who = await roomModerator(lk, room, null, { ...eva });
    const changed = await setMeetingControls(
      db(),
      room,
      who!,
      { boardPolicy: 'moderators', agentActions: false },
      null,
    );
    expect(changed).toMatchObject({
      boardPolicy: 'moderators',
      agentActions: false,
      pollsPolicy: 'everyone',
    });
    const [controls] = await sql<{ actor_id: string | null; meta: Record<string, unknown> }[]>`
      select actor_id, meta from audit_log where action = 'room.meeting_controls'`;
    expect(controls).toMatchObject({
      actor_id: null,
      meta: { boardPolicy: 'moderators', by: 'g-123456789abc' },
    });

    // A signed-in member promoted in the meeting moderates too, and is logged by account.
    people[1].role = 'moderator';
    expect(await roomModerator(lk, room, member)).toMatchObject({ userId: member.id, organizer: false });
    // Leaving the meeting ends the guest's permission: coming back, they are a guest again.
    lk.rooms.set(
      lkRoom,
      people.filter((p) => p.identity !== 'g-123456789abc'),
    );
    await expectAppError(moderate(db(), lk, room, null, 'mute_all', undefined, null, eva), 403);
    expect(await roomModerator(lk, room, null, eva)).toBeNull();
  });

  it('reads who a meeting token belongs to, and nothing from a bad or foreign one', async () => {
    const secret = 'a-very-long-livekit-secret-for-tests-0123456789';
    const token = new AccessToken('APIkey', secret, { identity: 'g-eva', name: 'Eva' });
    token.addGrant({ room: lkRoom, roomJoin: true });
    const jwt = await token.toJwt();
    expect(await tokenVerifier('APIkey', secret)(jwt)).toEqual({
      identity: 'g-eva',
      room: lkRoom,
      name: 'Eva',
    });
    expect(await tokenVerifier('APIkey', secret)('not-a-token')).toBeNull();
    expect(await tokenVerifier('APIkey', `${secret}-other`)(jwt)).toBeNull();
    const roomless = new AccessToken('APIkey', secret, { identity: 'g-eva' });
    expect(await tokenVerifier('APIkey', secret)(await roomless.toJwt())).toBeNull();
  });

  it('refuses non-moderators, unknown targets and acting on oneself', async () => {
    await expectAppError(moderate(db(), lk, room, member, 'remove', 'g-123456789abc', null), 403);
    await expectAppError(moderate(db(), lk, room, null, 'mute_all', undefined, null), 403);
    await expectAppError(moderate(db(), lk, room, admin, 'remove', 'ghost', null), 404);
    await expectAppError(moderate(db(), lk, room, admin, 'remove', undefined, null), 400);
    await expectAppError(moderate(db(), lk, room, admin, 'remove', `u-${admin.id}-aaaaaa`, null), 400);
    expect(lk.calls).toEqual([]);
  });
});

describe('studio', () => {
  const cfg = {
    livekitUrl: 'wss://lk.test',
    livekitApiKey: 'APIkey',
    livekitApiSecret: 'a-very-long-livekit-secret-for-tests-0123456789',
    agentName: 'kaiser',
  };
  const stage = (input: Record<string, unknown>) =>
    studioStateInput.parse({
      layout: 'grid',
      stage: [],
      screen: null,
      banners: [],
      banner: null,
      names: true,
      brand: { color: '#112233', background: '#000000', logo: null },
      ...input,
    });

  it('keeps the stage on the room, pushes it to the live room and opens the next session with it', async () => {
    const { tenant, user: admin } = await org('show');
    const room = await createRoom(db(), admin, R({ name: 'Live', studio: true }), null);
    expect(room.studio).toBe(true);
    const lk = new FakeLiveKit();
    const lkRoom = `${tenant.id}.${room.slug}`;
    const producer = { userId: admin.id, identity: `u-${admin.id}-aaaaaa`, name: 'Admin', organizer: true };
    expect(await studioState(db(), room)).toEqual(EMPTY_STUDIO);

    const saved = await saveStudio(
      db(),
      lk,
      room,
      producer,
      stage({
        layout: 'leader',
        stage: ['g-ana', 'g-bob', 'g-ana'],
        banners: [{ id: 'b1', text: 'Bem-vindos!', style: 'ticker' }],
        banner: 'b1',
      }),
      '10.0.0.1',
    );
    expect(saved).toMatchObject({ layout: 'leader', stage: ['g-ana', 'g-bob'], banner: 'b1' });
    expect(lk.calls).toEqual([
      `metadata ${lkRoom} ${JSON.stringify({ studio: saved, recording: false, live: null })}`,
    ]);
    expect(await studioState(db(), room)).toEqual(saved);

    // Only who goes on or off stage is logged.
    await saveStudio(db(), lk, room, producer, stage({ layout: 'solo', stage: ['g-bob', 'g-cid'] }), null);
    await saveStudio(db(), lk, room, producer, stage({ layout: 'grid', stage: ['g-bob', 'g-cid'] }), null);
    const logs = await sql<{ meta: Record<string, unknown> }[]>`
      select meta from audit_log where action = 'studio.stage' order by id`;
    expect(logs.map((l) => l.meta)).toEqual([
      { joined: 'g-ana,g-bob', left: '' },
      { joined: 'g-cid', left: 'g-ana' },
    ]);

    // A promoted guest produces too, and is logged by name.
    await saveStudio(db(), lk, room, { ...producer, userId: null, name: 'g-eva' }, stage({}), null);
    const [last] = await sql<{ actor_id: string | null; meta: Record<string, unknown> }[]>`
      select actor_id, meta from audit_log where action = 'studio.stage' order by id desc limit 1`;
    expect(last).toMatchObject({ actor_id: null, meta: { left: 'g-bob,g-cid', by: 'g-eva' } });

    await saveStudio(db(), lk, room, producer, stage({ stage: ['g-ana'], layout: 'pip' }), null);
    const grant = await grantJoin(db(), cfg, room, { identity: 'g-ana', displayName: 'Ana', role: 'guest' });
    expect(grant.studio).toBe(true);
    const claims = await new TokenVerifier(cfg.livekitApiKey, cfg.livekitApiSecret).verify(grant.token);
    expect(JSON.parse(claims.roomConfig?.metadata ?? '{}')).toMatchObject({
      studio: { layout: 'pip', stage: ['g-ana'] },
      recording: false,
      live: null,
    });
  });

  it('is only for studios and their producers; a meeting carries no stage', async () => {
    const { user: admin } = await org('meet');
    const meeting = await createRoom(db(), admin, R({ name: 'Reunião' }), null);
    const lk = new FakeLiveKit();
    const producer = { userId: admin.id, identity: 'u-x', name: 'Admin', organizer: true };
    await expectAppError(saveStudio(db(), lk, meeting, producer, stage({}), null), 400, /estúdio/);
    const grant = await grantJoin(db(), cfg, meeting, { identity: 'g-1', displayName: 'G', role: 'guest' });
    expect(grant.studio).toBe(false);
    const claims = await new TokenVerifier(cfg.livekitApiKey, cfg.livekitApiSecret).verify(grant.token);
    expect(JSON.parse(claims.roomConfig?.metadata ?? '')).toEqual({
      studio: null,
      recording: false,
      live: null,
    });

    const studio = await updateRoom(db(), admin, meeting.slug, updateRoomInput.parse({ studio: true }), null);
    expect(studio.studio).toBe(true);
    await expectAppError(saveStudio(db(), lk, studio, null, stage({}), null), 403);
    expect(lk.calls).toEqual([]);
  });

  it('accepts only a sane stage', () => {
    const bad = [
      { layout: 'mosaic' },
      { stage: Array.from({ length: 10 }, (_, i) => `g-${i}`) },
      { banners: [{ id: 'b 1', text: 'x', style: 'bar' }] },
      { banners: [{ id: 'b1', text: '   ', style: 'bar' }] },
      { banners: [{ id: 'b1', text: 'x'.repeat(201), style: 'bar' }] },
      { banner: 'nope' },
      { brand: { color: 'red', background: '#000000', logo: null } },
      { brand: { color: '#000000', background: '#000000', logo: 'http://logo.test/a.png' } },
      { extra: true },
    ];
    for (const input of bad) expect(() => stage(input)).toThrow();
    expect(
      stage({ brand: { color: '#000000', background: '#ffffff', logo: 'https://x.test/l.png' } }).brand.logo,
    ).toBe('https://x.test/l.png');
  });
});

describe('users', () => {
  let tenant: Tenant;
  let admin: SessionUser;
  let manager: SessionUser;
  let member: SessionUser;
  beforeEach(async () => {
    ({ tenant, user: admin } = await org('acme'));
    manager = await addUser(tenant, 'gestor@acme.test', 'manager');
    member = await addUser(tenant, 'bia@acme.test', 'member');
  });

  it('lets admins create any role and managers only plain users', async () => {
    const created = await createUser(
      db(),
      admin,
      { name: 'Nova', email: 'nova@acme.test', password: PASSWORD, role: 'manager' },
      null,
    );
    expect(created).toMatchObject({ role: 'manager', status: 'active' });
    await createUser(
      db(),
      manager,
      { name: 'Ana', email: 'ana@acme.test', password: PASSWORD, role: 'member' },
      null,
    );
    await expectAppError(
      createUser(db(), manager, { name: 'X', email: 'x@acme.test', password: PASSWORD, role: 'admin' }, null),
      403,
    );
    await expectAppError(
      createUser(db(), member, { name: 'Y', email: 'y@acme.test', password: PASSWORD, role: 'member' }, null),
      403,
    );
    await expectAppError(
      createUser(
        db(),
        admin,
        { name: 'Dup', email: 'bia@acme.test', password: PASSWORD, role: 'member' },
        null,
      ),
      409,
    );
    expect((await listUsers(db(), manager)).length).toBe(5);
    await expectAppError(listUsers(db(), member), 403);
  });

  it('changes roles, disables with session revocation, and resets passwords', async () => {
    const session = await createSession(db(), member.id, {});
    await updateUser(db(), admin, member.id, { role: 'manager' }, null);
    await updateUser(db(), admin, member.id, { status: 'disabled' }, null);
    expect(await findSessionUser(db(), session.token, tenant.id)).toBeNull();
    const reset = await updateUser(
      db(),
      admin,
      member.id,
      { status: 'active', password: 'outra-senha-forte', name: 'Bia S.' },
      null,
    );
    expect(reset).toMatchObject({ status: 'active', role: 'manager', name: 'Bia S.' });
    const [entry] =
      await sql`select meta from audit_log where action = 'user.updated' order by id desc limit 1`;
    expect(entry.meta.password).toBe('reset');
  });

  it('protects against privilege escalation and losing the last admin', async () => {
    await expectAppError(updateUser(db(), manager, member.id, { role: 'admin' }, null), 403);
    await expectAppError(updateUser(db(), manager, admin.id, { status: 'disabled' }, null), 403);
    await expectAppError(updateUser(db(), admin, admin.id, { role: 'member' }, null), 400);
    const second = await addUser(tenant, 'admin2@acme.test', 'admin');
    await updateUser(db(), second, admin.id, { role: 'member' }, null);
    const demoted: SessionUser = { ...admin, role: 'member' };
    await expectAppError(updateUser(db(), demoted, second.id, { status: 'disabled' }, null), 403);
    const { user: foreign } = await org('other');
    await expectAppError(updateUser(db(), foreign, member.id, { name: 'X' }, null), 404);
  });

  it('keeps at least one active admin', async () => {
    const second = await addUser(tenant, 'admin2@acme.test', 'admin');
    await updateUser(db(), admin, second.id, { status: 'disabled' }, null);
    await sql`update users set role = 'admin', status = 'active' where id = ${second.id}`;
    await sql`update users set status = 'disabled' where id = ${admin.id}`;
    await expectAppError(
      updateUser(db(), second, admin.id, { role: 'member' }, null),
      400,
      /pelo menos um admin/,
    );
  });
});

describe('branding, audit and live rooms', () => {
  it('updates branding (admins only) and lists the audit trail', async () => {
    const { tenant, user: admin } = await org('acme');
    const manager = await addUser(tenant, 'gestor@acme.test', 'manager');
    const branding = await updateBranding(
      db(),
      admin,
      {
        productName: 'Acme Meet',
        primaryColor: '#ff0055',
        logoUrl: 'https://cdn.acme.test/logo.svg',
        defaultLocale: 'es',
      },
      '203.0.113.4',
    );
    expect(branding).toEqual({
      productName: 'Acme Meet',
      primaryColor: '#ff0055',
      logoUrl: 'https://cdn.acme.test/logo.svg',
      defaultLocale: 'es',
    });
    await expectAppError(
      updateBranding(
        db(),
        manager,
        { productName: 'X', primaryColor: '#000000', logoUrl: null, defaultLocale: 'pt-BR' },
        null,
      ),
      403,
    );
    const audit = await listAudit(db(), admin, 10);
    expect(audit[0]).toMatchObject({ action: 'branding.updated', actorName: 'Admin', ip: '203.0.113.4' });
    await expectAppError(listAudit(db(), manager), 403);
  });

  it('shows only this organization’s open rooms with room names', async () => {
    const { tenant, user: admin } = await org('acme');
    const { tenant: other } = await org('other');
    const room = await createRoom(db(), admin, R({ name: 'Diretoria' }), null);
    const lk = new FakeLiveKit();
    lk.rooms.set(`${tenant.id}.${room.slug}`, [lk.participant('u-1', { name: 'Ana', handRaised: true })]);
    lk.rooms.set(`${tenant.id}.removida`, []);
    lk.rooms.set(`${other.id}.secreta`, [lk.participant('u-2')]);

    const live = await liveRooms(db(), lk, admin);
    expect(live).toEqual([
      {
        slug: room.slug,
        name: 'Diretoria',
        participants: [{ name: 'Ana', role: 'participant', isAgent: false, handRaised: true }],
      },
      { slug: 'removida', name: 'removida', participants: [] },
    ]);
    const member = await addUser(tenant, 'bia@acme.test', 'member');
    await expectAppError(liveRooms(db(), lk, member), 403);
    expect(await liveRooms(db(), new FakeLiveKit(), admin)).toEqual([]);
  });
});

describe('custom domains', () => {
  const PLATFORM = 'meet.impa.test';

  it('adds, verifies through DNS TXT, routes through Traefik and removes', async () => {
    const { tenant, user: admin } = await org('acme', 'pro');
    const domain = await addDomain(db(), admin, 'reuniao.acme.com', PLATFORM, null);
    expect(domain.verifiedAt).toBeNull();
    const record = verificationRecord(domain);
    expect(record.name).toBe('_impa-meet.reuniao.acme.com');

    await expectAppError(
      verifyDomain(db(), admin, 'reuniao.acme.com', async () => [['wrong']], null),
      400,
      /TXT/,
    );
    await expectAppError(
      verifyDomain(db(), admin, 'reuniao.acme.com', async () => Promise.reject(new Error('ENOTFOUND')), null),
      400,
    );
    const verified = await verifyDomain(
      db(),
      admin,
      'reuniao.acme.com',
      async (name) => (name === record.name ? [[record.value.slice(0, 10), record.value.slice(10)]] : []),
      null,
    );
    expect(verified.verifiedAt).not.toBeNull();
    expect(
      (await verifyDomain(db(), admin, 'reuniao.acme.com', async () => [], null)).verifiedAt,
    ).not.toBeNull();

    const config = await traefikDynamicConfig(db(), {
      platformDomain: PLATFORM,
      service: 'meet_platform@swarm',
      certResolver: 'le',
      entryPoint: 'websecure',
      includeTenantSubdomains: true,
    });
    expect(config.http.routers).toEqual({
      'impa-meet-acme-meet-impa-test': {
        rule: 'Host(`acme.meet.impa.test`)',
        entryPoints: ['websecure'],
        service: 'meet_platform@swarm',
        tls: { certResolver: 'le' },
      },
      'impa-meet-reuniao-acme-com': {
        rule: 'Host(`reuniao.acme.com`)',
        entryPoints: ['websecure'],
        service: 'meet_platform@swarm',
        tls: { certResolver: 'le' },
      },
    });

    await sql`update tenants set status = 'suspended' where id = ${tenant.id}`;
    const suspended = await traefikDynamicConfig(db(), {
      platformDomain: PLATFORM,
      service: 's',
      certResolver: 'le',
      entryPoint: 'websecure',
      includeTenantSubdomains: false,
    });
    expect(suspended.http.routers).toEqual({});
    await sql`update tenants set status = 'active' where id = ${tenant.id}`;

    expect(await listDomains(db(), admin)).toHaveLength(1);
    await removeDomain(db(), admin, 'reuniao.acme.com', null);
    expect(await listDomains(db(), admin)).toHaveLength(0);
    await expectAppError(removeDomain(db(), admin, 'reuniao.acme.com', null), 404);
    await expectAppError(
      verifyDomain(db(), admin, 'reuniao.acme.com', async () => [], null),
      404,
    );
  });

  it('enforces plan, ownership, uniqueness and platform hostnames', async () => {
    const { user: free } = await org('free', 'free');
    await expectAppError(addDomain(db(), free, 'x.free.com', PLATFORM, null), 403, /plano/);

    const { tenant, user: admin } = await org('acme', 'pro');
    const { user: other } = await org('other', 'pro');
    await expectAppError(addDomain(db(), admin, 'meet.impa.test', PLATFORM, null), 400);
    await expectAppError(addDomain(db(), admin, 'evil.meet.impa.test', PLATFORM, null), 400);
    await addDomain(db(), admin, 'reuniao.acme.com', PLATFORM, null);
    await expectAppError(addDomain(db(), other, 'reuniao.acme.com', PLATFORM, null), 409);
    await expectAppError(removeDomain(db(), other, 'reuniao.acme.com', null), 404);
    const manager = await addUser(tenant, 'gestor@acme.test', 'manager');
    await expectAppError(listDomains(db(), manager), 403);
  });
});

describe('super admin', () => {
  it('lists tenants with usage and manages plan, limits and suspension', async () => {
    const { user: root } = await org('impa');
    await sql`update users set is_superadmin = true where id = ${root.id}`;
    const superadmin = { ...root, isSuperadmin: true };
    const { tenant: client, user: clientAdmin } = await org('cliente', 'free');
    await createRoom(db(), clientAdmin, R({ name: 'Uma' }), null);
    const clientSession = await createSession(db(), clientAdmin.id, {});

    const tenants = await listTenants(db(), superadmin);
    expect(tenants.find((t) => t.slug === 'cliente')).toMatchObject({
      plan: 'free',
      users: 1,
      rooms: 1,
      domains: 0,
    });

    await updateTenant(db(), superadmin, client.id, { plan: 'pro', limits: { maxParticipants: 40 } }, null);
    expect(await tenantLimits(db(), client.id)).toMatchObject({
      maxRooms: 200,
      maxParticipants: 40,
      agents: true,
    });

    await updateTenant(db(), superadmin, client.id, { status: 'suspended' }, null);
    expect(await findSessionUser(db(), clientSession.token, client.id)).toBeNull();

    await expectAppError(updateTenant(db(), superadmin, root.tenantId, { status: 'suspended' }, null), 400);
    await expectAppError(updateTenant(db(), superadmin, client.id, { limits: { maxRooms: -1 } }, null), 400);
    await expectAppError(
      updateTenant(db(), superadmin, '00000000-0000-4000-8000-000000000000', { plan: 'pro' }, null),
      404,
    );
    await expectAppError(listTenants(db(), clientAdmin), 403);
    await expectAppError(listTenants(db(), null), 403);
    const [entry] =
      await sql`select tenant_id, action from audit_log where action = 'tenant.updated' limit 1`;
    expect(entry.tenant_id).toBe(client.id);
  });
});

describe('room access, as in Google Meet', () => {
  it('lets members into trusted rooms and only invited people into restricted ones', async () => {
    const { user: admin, tenant } = await org('acme');
    const member = await addUser(tenant, 'bia@acme.test', 'member');
    const other = await addUser(tenant, 'caio@acme.test', 'member');
    const room = await createRoom(db(), admin, R({ name: 'Aula' }), null);
    expect(room).toMatchObject({ access: 'trusted', boardPolicy: 'everyone', pollsPolicy: 'everyone' });
    expect(await entersDirectly(db(), room, member, 'participant')).toBe(true);
    expect(await entersDirectly(db(), room, null, 'guest')).toBe(false);

    const restricted = await updateRoom(db(), admin, room.slug, { access: 'restricted' }, null);
    expect(await entersDirectly(db(), restricted, member, 'participant')).toBe(false);
    await setInvites(db(), admin, restricted, ['bia@acme.test'], null);
    expect(await listInvites(db(), restricted)).toEqual(['bia@acme.test']);
    expect(await entersDirectly(db(), restricted, member, 'participant')).toBe(true);
    expect(await entersDirectly(db(), restricted, other, 'participant')).toBe(false);
    expect(await entersDirectly(db(), restricted, other, 'moderator')).toBe(true);
    await expectAppError(setInvites(db(), member, restricted, [], null), 403);
    await setInvites(db(), admin, restricted, [], null);
    expect(await listInvites(db(), restricted)).toEqual([]);

    const open = await updateRoom(
      db(),
      admin,
      room.slug,
      { access: 'open', boardPolicy: 'moderators' },
      null,
    );
    expect(open.boardPolicy).toBe('moderators');
    expect(await entersDirectly(db(), open, null, 'guest')).toBe(true);
  });
});

describe('moderation by an AI agent', () => {
  async function setup(tools: string[], rules = '') {
    const { tenant, user } = await org('acme');
    const [kaiser] = await listAgents(db(), user);
    const choices = await agentChoices(db(), user);
    await updateAgent(
      db(),
      user,
      kaiser.id,
      agentInput.parse({
        name: 'Kaiser',
        instructions: 'x',
        ...choices,
        moderationTools: tools,
        moderationRules: rules,
      }),
      null,
    );
    const room = await createRoom(db(), user, R({ name: 'Aula', agentIds: [kaiser.id] }), null);
    const lkRoom = `${tenant.id}.${room.slug}`;
    const lk = new FakeLiveKit();
    const mod = lk.participant(`u-${user.id}-a1`, { name: 'Ana', role: 'moderator' });
    const john = lk.participant('g-john', { name: 'João', role: 'guest' });
    const mary = lk.participant('g-mary', { name: 'Maria', role: 'guest' });
    const bot = lk.participant('agent-AJ_1', { name: 'Kaiser', isAgent: true });
    lk.rooms.set(lkRoom, [mod, john, mary, bot]);
    const act = (input: Record<string, unknown>) =>
      agentModerate(db(), lk, kaiser.id, agentModerationInput.parse({ room: lkRoom, ...input }));
    return { tenant, user, kaiser, room, lkRoom, lk, mod, act };
  }

  it('does nothing unless the admin turned the action on', async () => {
    const { act, mod } = await setup([]);
    await expectAppError(
      act({ action: 'remove', target: 'g-john', requestedBy: mod.identity }),
      403,
      /permissão/,
    );
  });

  it('acts when a moderator asks, never on protected people, and logs who asked', async () => {
    const { act, mod, lk, kaiser, lkRoom, user } = await setup(['remove', 'mute']);
    // nobody asked and there are no rules: refused
    await expectAppError(act({ action: 'mute', target: 'g-john' }), 403, /moderador/);
    // a guest asking does not count
    await expectAppError(act({ action: 'remove', target: 'g-mary', requestedBy: 'g-john' }), 403);
    // moderators, the room owner and other assistants are off limits
    await expectAppError(
      act({ action: 'remove', target: mod.identity, requestedBy: mod.identity }),
      403,
      /IA não age/,
    );
    await expectAppError(act({ action: 'mute', target: 'agent-AJ_1', requestedBy: mod.identity }), 403);
    await expectAppError(act({ action: 'mute', target: 'g-nobody', requestedBy: mod.identity }), 404);

    expect(await act({ action: 'mute', target: 'g-mary', requestedBy: mod.identity })).toEqual({
      done: 'Maria teve o microfone silenciado',
    });
    expect(await act({ action: 'remove', target: 'g-john', requestedBy: mod.identity })).toEqual({
      done: 'João foi removido da chamada',
    });
    expect(lk.calls).toEqual(['mute g-mary TR_g-mary', 'remove g-john']);

    const view = await agentModerationView(db(), lk, kaiser.id, lkRoom);
    expect(view.people.map((p) => [p.name, p.protected])).toEqual([
      ['Ana', true],
      ['João', false],
      ['Maria', false],
    ]);
    const [entry] = await sql<{ action: string; actorId: string | null; meta: Record<string, string> }[]>`
      select action, actor_id as "actorId", meta from audit_log
      where action = 'moderation.remove' order by created_at desc limit 1`;
    expect(entry).toMatchObject({
      actorId: user.id,
      meta: { via: 'ai', agent: 'Kaiser', requestedBy: 'Ana' },
    });
  });

  it('applies the admin rules on its own, for the waiting room too', async () => {
    const noRules = await setup(['lobby']);
    const waiting = await requestEntry(db(), noRules.room, null, 'Carlos');
    await expectAppError(noRules.act({ action: 'admit', target: waiting.id, rule: 'aprovar todos' }), 403);

    await sql`truncate tenants, audit_log restart identity cascade`;
    const { act, room, kaiser, lk, lkRoom } = await setup(['lobby'], 'Aprove quem pedir para entrar.');
    const ticket = await requestEntry(db(), room, null, 'Carlos');
    expect((await agentModerationView(db(), lk, kaiser.id, lkRoom)).lobby).toEqual([
      { id: ticket.id, name: 'Carlos' },
    ]);
    await expectAppError(act({ action: 'admit', target: ticket.id }), 403); // no rule cited
    expect(await act({ action: 'admit', target: ticket.id, rule: 'Aprove quem pedir para entrar.' })).toEqual(
      {
        done: 'Carlos entrou',
      },
    );
    expect((await entryStatus(db(), room, ticket.id, ticket.secret)).status).toBe('approved');
    await expectAppError(act({ action: 'deny', target: ticket.id, rule: 'x' }), 404);
    // only the lobby tool is on
    await expectAppError(act({ action: 'mute', target: 'g-john', rule: 'x' }), 403, /permissão/);
  });

  it('switches cameras off and records only when a moderator asks, never by a rule', async () => {
    const { act, mod, lk, lkRoom, room, kaiser, user } = await setup(
      ['camera', 'record'],
      'Grave toda reunião.',
    );
    const john = lk.rooms.get(lkRoom)!.find((p) => p.identity === 'g-john')!;
    john.videoTrackSids = ['TV_john'];
    john.videoMuted = false;
    // rules never switch a camera off or start a recording
    await expectAppError(
      act({ action: 'camera', target: 'g-john', rule: 'Grave toda reunião.' }),
      403,
      /moderador/,
    );
    await expectAppError(act({ action: 'record_start', target: 'room', rule: 'Grave toda reunião.' }), 403);
    await expectAppError(act({ action: 'camera', target: mod.identity, requestedBy: mod.identity }), 403);

    expect(await act({ action: 'camera', target: 'g-john', requestedBy: mod.identity })).toEqual({
      done: 'João teve a câmera desligada',
    });
    expect(lk.calls).toEqual(['mute g-john TV_john']);
    expect(
      (await agentModerationView(db(), lk, kaiser.id, lkRoom)).people.find((p) => p.name === 'João'),
    ).toMatchObject({ camOn: true, micOn: true });

    // recording needs the recorder installed, and only the main room is recorded
    await expectAppError(act({ action: 'record_start', target: 'room', requestedBy: mod.identity }), 501);
    const started: string[] = [];
    const recorder = {
      sql: db(),
      lk,
      outputDir: '/out',
      egress: {
        start: async (r: string) => {
          started.push(r);
          return `EG_${started.length}`;
        },
        stop: async () => {},
        info: async () => null,
      },
    };
    const record = (input: Record<string, unknown>) =>
      agentModerate(db(), lk, kaiser.id, agentModerationInput.parse(input), recorder);
    lk.rooms.set(`${lkRoom}~1`, [mod]);
    await expectAppError(
      record({ room: `${lkRoom}~1`, action: 'record_start', target: 'room', requestedBy: mod.identity }),
      400,
    );
    expect(
      await record({ room: lkRoom, action: 'record_start', target: 'room', requestedBy: mod.identity }),
    ).toEqual({
      done: 'A gravação começou',
    });
    expect(started).toEqual([lkRoom]);
    await expectAppError(
      record({ room: lkRoom, action: 'record_start', target: 'room', requestedBy: mod.identity }),
      409,
    );
    expect(
      await record({ room: lkRoom, action: 'record_stop', target: 'room', requestedBy: mod.identity }),
    ).toEqual({
      done: 'A gravação foi encerrada',
    });
    const [rec] = await sql<{ startedBy: string }[]>`select started_by as "startedBy" from recordings`;
    expect(rec.startedBy).toBe(identityUserId(mod.identity));
    const audits = await sql<{ action: string; meta: Record<string, string> }[]>`
      select action, meta from audit_log where action like 'recording.%' order by id`;
    expect(audits.map((a) => [a.action, a.meta.via, a.meta.requestedBy])).toEqual([
      ['recording.started', 'ai', 'Ana'],
      ['recording.stopped', 'ai', 'Ana'],
    ]);

    // a moderator switches the AI's actions off for this room: everything stops at once
    await updateRoom(db(), user, room.slug, updateRoomInput.parse({ agentActions: false }), null);
    await expectAppError(
      act({ action: 'camera', target: 'g-john', requestedBy: mod.identity }),
      403,
      /desligaram/,
    );
    expect((await agentModerationView(db(), lk, kaiser.id, lkRoom)).actions).toBe(false);
  });

  it('only works in rooms the agent was put in, of its own organization', async () => {
    const { kaiser, lk, tenant } = await setup(['remove']);
    await expectAppError(agentModerationView(db(), lk, kaiser.id, `${tenant.id}.outra-sala`), 404);
    const rival = await org('rival');
    await expectAppError(agentModerationView(db(), lk, kaiser.id, `${rival.tenant.id}.aula`), 404);
  });
});
