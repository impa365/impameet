import { TokenVerifier } from 'livekit-server-sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  agentForWorker,
  createAgent,
  defaultAgentId,
  deleteAgent,
  listAgents,
  updateAgent,
} from '@/server/agents/service';
import { signup } from '@/server/auth/service';
import type { SessionUser } from '@/server/auth/session';
import type { Sql } from '@/server/db';
import { AppError } from '@/server/errors';
import { grantJoin } from '@/server/rooms/join';
import { createRoom, findRoom, updateRoom } from '@/server/rooms/service';
import { hashPassword } from '@/server/security/password';
import { agentInput, createRoomInput } from '@/server/validation';
import { type TestSql, freshDatabase } from './db';
import { agentChoices } from './ready-agent';

let sql: TestSql;
const db = () => sql as unknown as Sql;
const PASSWORD = 'senha-muito-segura';
const choices = new Map<string, Record<string, unknown>>();
let lastTenant = '';
/** An agent of the organization 	enantId (the last one created by default), with all its choices made. */
const A = (input: Record<string, unknown>, tenantId = lastTenant) =>
  agentInput.parse({ instructions: 'Você é útil.', ...choices.get(tenantId), ...input });

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

async function expectAppError(promise: Promise<unknown>, status: number) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).status).toBe(status);
}

async function org(slug: string) {
  const { tenant, user } = await signup(
    db(),
    { organization: `Org ${slug}`, slug, name: 'Admin', email: `admin@${slug}.test`, password: PASSWORD },
    null,
    'enterprise',
  );
  const [member] = await sql<SessionUser[]>`
    insert into users (tenant_id, email, name, password_hash, role)
    values (${tenant.id}, ${`bia@${slug}.test`}, 'Bia', ${await hashPassword(PASSWORD)}, 'member')
    returning id, tenant_id as "tenantId", email, name, role, is_superadmin as "isSuperadmin"`;
  choices.set(tenant.id, await agentChoices(db(), user));
  lastTenant = tenant.id;
  return { tenant, admin: user, member };
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

describe('agents', () => {
  it('admins create, train, update and delete agents; everything is audited', async () => {
    const { admin, member } = await org('acme');
    const kaiser = await createAgent(
      db(),
      admin,
      A({ name: 'Max', knowledge: 'Horário: 9h às 18h.', greeting: 'Olá!', respondMode: 'when_named' }),
      '10.0.0.1',
    );
    expect(kaiser).toMatchObject({
      name: 'Max',
      knowledge: 'Horário: 9h às 18h.',
      listenMode: 'everyone',
      respondMode: 'when_named',
      mutePolicy: 'everyone',
      ttsModel: 's2.1-pro',
      sttModel: 'transcribe-stream-1',
      voiceId: 'voz-teste-1',
      ready: true,
    });

    expect((await listAgents(db(), member)).map((a) => a.name)).toEqual(['Kaiser', 'Max']);
    // Presenting on the board is its own permission, next to looking at it.
    const presenter = await createAgent(
      db(),
      admin,
      A({ name: 'Apresentador', perception: ['present'] }),
      null,
    );
    expect((await agentForWorker(db(), null, presenter.id))?.perception).toEqual(['present']);
    await deleteAgent(db(), admin, presenter.id, null);
    expect(() => A({ name: 'X', perception: ['draw'] })).toThrow();
    await expectAppError(createAgent(db(), member, A({ name: 'Outro' }), null), 403);
    await expectAppError(createAgent(db(), admin, A({ name: 'Max' }), null), 409);

    const updated = await updateAgent(
      db(),
      admin,
      kaiser.id,
      A({
        name: 'Max 2',
        listenMode: 'moderators',
        mutePolicy: 'moderators',
        voices: { pt: 'fbeaed047d8e476f803ee0823a144d8c', en: 'voice-en-1234' },
      }),
      null,
    );
    expect(updated).toMatchObject({
      name: 'Max 2',
      listenMode: 'moderators',
      mutePolicy: 'moderators',
      knowledge: '',
      voiceId: 'fbeaed047d8e476f803ee0823a144d8c',
      voices: { pt: 'fbeaed047d8e476f803ee0823a144d8c', en: 'voice-en-1234' },
    });
    expect(() => A({ name: 'Sem voz', voices: {} })).toThrow();
    expect(() => A({ name: 'Sem LLM', llmIntegrationId: undefined })).toThrow();
    expect(() => A({ name: 'Sem modelo', llmModel: '' })).toThrow();
    await createAgent(db(), admin, A({ name: 'Ana' }), null);
    await expectAppError(updateAgent(db(), admin, updated.id, A({ name: 'Ana' }), null), 409);
    await expectAppError(updateAgent(db(), member, updated.id, A({ name: 'X' }), null), 403);

    await deleteAgent(db(), admin, updated.id, null);
    await expectAppError(deleteAgent(db(), admin, updated.id, null), 404);
    await expectAppError(updateAgent(db(), admin, updated.id, A({ name: 'Y' }), null), 404);
    const actions = await sql<{ action: string }[]>`select action from audit_log order by id`;
    expect(actions.map((a) => a.action)).toEqual(
      expect.arrayContaining(['agent.created', 'agent.updated', 'agent.deleted']),
    );
  });

  it('keeps agents isolated per organization', async () => {
    const { admin } = await org('acme');
    const { admin: rival } = await org('rival');
    const agent = await createAgent(db(), admin, A({ name: 'Max' }, admin.tenantId), null);
    const theirs = await listAgents(db(), rival);
    expect(theirs.map((a) => [a.name, a.tenantId])).toEqual([['Kaiser', rival.tenantId]]);
    await expectAppError(updateAgent(db(), rival, agent.id, A({ name: 'Roubado' }), null), 404);
    await expectAppError(deleteAgent(db(), rival, agent.id, null), 404);
    await expectAppError(
      createRoom(
        db(),
        rival,
        createRoomInput.parse({ name: 'S', agentEnabled: true, agentId: agent.id }),
        null,
      ),
      404,
    );
  });

  it('serves the worker only agents of active organizations', async () => {
    const { admin, tenant } = await org('acme');
    const agent = await createAgent(db(), admin, A({ name: 'Max', knowledge: 'FAQ' }), null);
    expect(await agentForWorker(db(), null, agent.id)).toMatchObject({
      name: 'Max',
      knowledge: 'FAQ',
      listenMode: 'everyone',
      respondMode: 'always',
      mutePolicy: 'everyone',
    });
    expect(await agentForWorker(db(), null, '00000000-0000-0000-0000-000000000000')).toBeNull();
    await sql`update tenants set status = 'suspended' where id = ${tenant.id}`;
    expect(await agentForWorker(db(), null, agent.id)).toBeNull();
  });
});

describe('rooms with a chosen agent', () => {
  it('stores the agent, sends it in the dispatch metadata and clears it when the agent is deleted', async () => {
    const { admin, tenant } = await org('acme');
    const agent = await createAgent(db(), admin, A({ name: 'Max' }), null);
    const room = await createRoom(
      db(),
      admin,
      createRoomInput.parse({ name: 'Vendas', agentEnabled: true, agentId: agent.id }),
      null,
    );
    expect(room.agentId).toBe(agent.id);

    const grant = await grantJoin(db(), cfg, room, { identity: 'g-1', displayName: 'G', role: 'guest' });
    const claims = await new TokenVerifier(cfg.livekitApiKey, cfg.livekitApiSecret).verify(grant.token);
    const dispatch = claims.roomConfig?.agents?.[0];
    expect(dispatch?.agentName).toBe('kaiser');
    expect(JSON.parse(dispatch?.metadata ?? '{}')).toEqual({
      agentId: agent.id,
      agentName: agent.name,
      tenantId: tenant.id,
      thinkingSound: true,
      agentActions: true,
      boardPolicy: 'everyone',
    });

    const fallback = await defaultAgentId(db(), tenant.id);
    expect((await updateRoom(db(), admin, room.slug, { agentId: null }, null)).agentIds).toEqual([fallback]);
    expect((await updateRoom(db(), admin, room.slug, { agentId: agent.id }, null)).agentId).toBe(agent.id);
    await expectAppError(
      updateRoom(db(), admin, room.slug, { agentId: '00000000-0000-0000-0000-000000000000' }, null),
      404,
    );

    await deleteAgent(db(), admin, agent.id, null);
    expect((await findRoom(db(), tenant.id, room.slug))?.agentIds).toEqual([]);
  });
});
