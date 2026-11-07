import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  agentForWorker,
  createAgent,
  defaultAgentId,
  deleteAgent,
  listAgents,
  setDefaultAgent,
  updateAgent,
} from '@/server/agents/service';
import { signup } from '@/server/auth/service';
import type { SessionUser } from '@/server/auth/session';
import type { Sql } from '@/server/db';
import { AppError } from '@/server/errors';
import type { Fetch } from '@/server/integrations/probe';
import {
  type IntegrationDeps,
  createIntegration,
  deleteIntegration,
  integrationSecret,
  listIntegrations,
  testIntegration,
  updateIntegration,
} from '@/server/integrations/service';
import { grantJoin } from '@/server/rooms/join';
import { createRoom, updateRoom } from '@/server/rooms/service';
import { hashPassword } from '@/server/security/password';
import { agentInput, createRoomInput, integrationInput, updateRoomInput } from '@/server/validation';
import { TokenVerifier } from 'livekit-server-sdk';
import { type TestSql, freshDatabase } from './db';

let sql: TestSql;
const db = () => sql as unknown as Sql;
const KEY = randomBytes(32);
const resolve = async (host: string) => (host === 'intranet.example' ? ['10.0.0.5'] : ['93.184.215.14']);
const deps = (fetchImpl?: Fetch): IntegrationDeps => ({ sql: db(), key: KEY, resolve, fetch: fetchImpl });
const LLM = (over: Record<string, unknown> = {}) =>
  integrationInput.parse({
    kind: 'llm',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'sk-or-0123456789abcdef',
    defaultModel: 'deepseek/deepseek-chat',
    ...over,
  });
const FISH = (over: Record<string, unknown> = {}) =>
  integrationInput.parse({ kind: 'fish', name: 'Fish principal', apiKey: 'fish-0123456789abcdef', ...over });
const DEEPGRAM = (over: Record<string, unknown> = {}) =>
  integrationInput.parse({ kind: 'deepgram', name: 'Deepgram', apiKey: 'dg-0123456789abcdef', ...over });
const ELEVEN = (over: Record<string, unknown> = {}) =>
  integrationInput.parse({ kind: 'elevenlabs', name: 'ElevenLabs', apiKey: 'el-0123456789abcdef', ...over });
/** Everything an agent must choose (nothing comes from the server). */
const READY = {
  llmModel: 'deepseek/deepseek-chat',
  ttsModel: 's2.1-pro',
  sttModel: 'transcribe-stream-1',
  voices: { pt: 'voz-teste-1' },
};
const A = (over: Record<string, unknown> = {}) =>
  agentInput.parse({ name: 'Ana', instructions: 'x', ...READY, ...over });

/** A ready-to-use LLM and Fish Audio (speaking and listening) for an organization's agents. */
async function providers(admin: SessionUser) {
  const llm = await createIntegration(deps(), admin, LLM({ name: 'LLM de teste' }), null);
  const fish = await createIntegration(deps(), admin, FISH({ name: 'Fish de teste' }), null);
  return { llmIntegrationId: llm.id, ttsIntegrationId: fish.id, sttIntegrationId: fish.id };
}

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
    { organization: slug, slug, name: 'Admin', email: `admin@${slug}.test`, password: 'senha-muito-segura' },
    null,
    'enterprise',
  );
  const [member] = await sql<SessionUser[]>`
    insert into users (tenant_id, email, name, password_hash, role)
    values (${tenant.id}, ${`bia@${slug}.test`}, 'Bia', ${await hashPassword('senha-muito-segura')}, 'member')
    returning id, tenant_id as "tenantId", email, name, role, is_superadmin as "isSuperadmin"`;
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

describe('the default agent', () => {
  it('exists, is editable, can be replaced as default but never deleted while default', async () => {
    const { admin, tenant } = await org('acme');
    const [kaiser] = await listAgents(db(), admin);
    expect(kaiser).toMatchObject({ name: 'Kaiser', isDefault: true });
    expect(await defaultAgentId(db(), tenant.id)).toBe(kaiser.id);

    const chosen = await providers(admin);
    const edited = await updateAgent(
      db(),
      admin,
      kaiser.id,
      A({ name: 'Kaiser', greeting: 'Olá!', ...chosen }),
      null,
    );
    expect(edited).toMatchObject({ greeting: 'Olá!', isDefault: true });
    await expectAppError(deleteAgent(db(), admin, kaiser.id, null), 400);

    const ana = await createAgent(db(), admin, A(chosen), null);
    await setDefaultAgent(db(), admin, ana.id, null);
    expect((await listAgents(db(), admin)).map((a) => [a.name, a.isDefault])).toEqual([
      ['Ana', true],
      ['Kaiser', false],
    ]);
    await deleteAgent(db(), admin, kaiser.id, null);
    await expectAppError(setDefaultAgent(db(), admin, kaiser.id, null), 404);
  });

  it('joins rooms that switch the AI on without choosing an agent', async () => {
    const { admin, tenant } = await org('acme');
    const room = await createRoom(
      db(),
      admin,
      createRoomInput.parse({ name: 'Sala', agentEnabled: true }),
      null,
    );
    const [kaiser] = await listAgents(db(), admin);
    await updateAgent(db(), admin, kaiser.id, A({ name: 'Kaiser', ...(await providers(admin)) }), null);
    const cfg = {
      livekitUrl: 'wss://lk.test',
      livekitApiKey: 'APIkey',
      livekitApiSecret: 'a-very-long-livekit-secret-for-tests-0123456789',
      agentName: 'kaiser',
    };
    const grant = await grantJoin(db(), cfg, room, { identity: 'g-1', displayName: 'G', role: 'guest' });
    const claims = await new TokenVerifier(cfg.livekitApiKey, cfg.livekitApiSecret).verify(grant.token);
    const meta = JSON.parse(claims.roomConfig?.agents?.[0]?.metadata ?? '{}');
    expect(meta).toEqual({
      agentId: await defaultAgentId(db(), tenant.id),
      agentName: 'Kaiser',
      tenantId: tenant.id,
      thinkingSound: true,
    });

    // The typing sound is a per-room switch the agent receives with the dispatch.
    expect(room.thinkingSound).toBe(true);
    const quiet = await updateRoom(
      db(),
      admin,
      room.slug,
      updateRoomInput.parse({ thinkingSound: false }),
      null,
    );
    expect(quiet.thinkingSound).toBe(false);
    const again = await grantJoin(db(), cfg, quiet, { identity: 'g-2', displayName: 'G', role: 'guest' });
    const claims2 = await new TokenVerifier(cfg.livekitApiKey, cfg.livekitApiSecret).verify(again.token);
    expect(JSON.parse(claims2.roomConfig?.agents?.[0]?.metadata ?? '{}').thinkingSound).toBe(false);
  });
});

describe('integrations', () => {
  it('stores keys sealed, lists only a hint, and keeps the key when edited without one', async () => {
    const { admin, tenant } = await org('acme');
    const llm = await createIntegration(deps(), admin, LLM({ models: ['openai/gpt-4.1-mini'] }), null);
    expect(llm).toMatchObject({
      kind: 'llm',
      baseUrl: 'https://openrouter.ai/api/v1',
      defaultModel: 'deepseek/deepseek-chat',
      models: ['deepseek/deepseek-chat', 'openai/gpt-4.1-mini'],
      secretHint: '••••cdef',
      usedBy: 0,
    });
    expect(JSON.stringify(llm)).not.toContain('sk-or-');
    const [row] = await sql<{ sealed: string }[]>`select secret_sealed as sealed from integrations`;
    expect(row.sealed).not.toContain('sk-or-');

    await updateIntegration(deps(), admin, llm.id, LLM({ name: 'OpenRouter 2', apiKey: undefined }), null);
    expect((await integrationSecret(db(), KEY, tenant.id, llm.id)).apiKey).toBe('sk-or-0123456789abcdef');
    const rotated = await updateIntegration(
      deps(),
      admin,
      llm.id,
      LLM({ apiKey: 'sk-or-new-key-999999' }),
      null,
    );
    expect(rotated.secretHint).toBe('••••9999');
    expect((await integrationSecret(db(), KEY, tenant.id, llm.id)).apiKey).toBe('sk-or-new-key-999999');

    const fish = await createIntegration(deps(), admin, FISH(), null);
    expect(fish).toMatchObject({ kind: 'fish', baseUrl: null, defaultModel: 's2.1-pro' });
    expect((await listIntegrations(db(), admin)).map((i) => i.name)).toEqual([
      'Fish principal',
      'OpenRouter',
    ]);
  });

  it('refuses members, internal URLs, missing keys, duplicates and kind changes', async () => {
    const { admin, member } = await org('acme');
    await expectAppError(listIntegrations(db(), member), 403);
    await expectAppError(createIntegration(deps(), member, LLM(), null), 403);
    await expectAppError(
      createIntegration(deps(), admin, LLM({ baseUrl: 'https://intranet.example/v1' }), null),
      400,
    );
    await expectAppError(
      createIntegration(deps(), admin, LLM({ baseUrl: 'http://openrouter.ai/v1' }), null),
      400,
    );
    await expectAppError(createIntegration(deps(), admin, LLM({ apiKey: undefined }), null), 400);
    const llm = await createIntegration(deps(), admin, LLM(), null);
    await expectAppError(createIntegration(deps(), admin, LLM(), null), 409);
    await expectAppError(updateIntegration(deps(), admin, llm.id, FISH({ name: 'OpenRouter' }), null), 400);
  });

  it('tests the saved key live and records the outcome', async () => {
    const { admin } = await org('acme');
    const llm = await createIntegration(deps(), admin, LLM(), null);
    const seen: string[] = [];
    const ok = (async (url: string, init: RequestInit) => {
      seen.push(`${url} ${new Headers(init.headers).get('authorization')}`);
      return Response.json({ data: [{ id: 'deepseek/deepseek-chat' }, { id: 'qwen/qwen3' }] });
    }) as unknown as Fetch;
    expect(await testIntegration(deps(ok), admin, llm.id)).toEqual({
      ok: true,
      models: ['deepseek/deepseek-chat', 'qwen/qwen3'],
    });
    expect(seen).toEqual(['https://openrouter.ai/api/v1/models Bearer sk-or-0123456789abcdef']);
    const refused = (async () => new Response('{}', { status: 401 })) as unknown as Fetch;
    const fish = await createIntegration(deps(), admin, FISH(), null);
    expect((await testIntegration(deps(refused), admin, fish.id)).ok).toBe(false);
    const list = await listIntegrations(db(), admin);
    expect(list.map((i) => [i.name, i.lastTestOk])).toEqual([
      ['Fish principal', false],
      ['OpenRouter', true],
    ]);
    expect(list[0].lastTestError).toContain('recusada');
  });

  it('keeps organizations apart, even if a sealed key is copied between them', async () => {
    const { admin } = await org('acme');
    const rival = await org('rival');
    const llm = await createIntegration(deps(), admin, LLM(), null);
    expect(await listIntegrations(db(), rival.admin)).toEqual([]);
    await expectAppError(updateIntegration(deps(), rival.admin, llm.id, LLM(), null), 404);
    await expectAppError(deleteIntegration(db(), rival.admin, llm.id, null), 404);
    const rivalFish = await createIntegration(deps(), rival.admin, FISH(), null);
    await expectAppError(
      createAgent(
        db(),
        rival.admin,
        A({ llmIntegrationId: llm.id, ttsIntegrationId: rivalFish.id, sttIntegrationId: rivalFish.id }),
        null,
      ),
      404,
    );

    const theirs = await createIntegration(deps(), rival.admin, LLM(), null);
    await sql`update integrations set secret_sealed = (select secret_sealed from integrations where id = ${llm.id})
              where id = ${theirs.id}`;
    await expect(integrationSecret(db(), KEY, rival.tenant.id, theirs.id)).rejects.toThrow();
  });
});

describe('agents with their own provider keys', () => {
  it('pick an integration and model, and the worker receives the decrypted credentials', async () => {
    const { admin } = await org('acme');
    const llm = await createIntegration(deps(), admin, LLM(), null);
    const fish = await createIntegration(deps(), admin, FISH(), null);
    await expectAppError(
      createAgent(
        db(),
        admin,
        A({ llmIntegrationId: fish.id, ttsIntegrationId: fish.id, sttIntegrationId: fish.id }),
        null,
      ),
      400,
    );
    await expectAppError(
      createAgent(
        db(),
        admin,
        A({ llmIntegrationId: llm.id, ttsIntegrationId: llm.id, sttIntegrationId: fish.id }),
        null,
      ),
      400,
    );

    const ana = await createAgent(
      db(),
      admin,
      A({
        llmIntegrationId: llm.id,
        ttsIntegrationId: fish.id,
        sttIntegrationId: fish.id,
        ttsModel: 'drama-3',
      }),
      null,
    );
    expect(await agentForWorker(db(), KEY, ana.id)).toMatchObject({
      name: 'Ana',
      llmModel: 'deepseek/deepseek-chat',
      llm: {
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'sk-or-0123456789abcdef',
        model: 'deepseek/deepseek-chat',
      },
      tts: { provider: 'fish', apiKey: 'fish-0123456789abcdef' },
      stt: { provider: 'fish', apiKey: 'fish-0123456789abcdef' },
      ttsModel: 'drama-3',
    });

    await updateAgent(
      db(),
      admin,
      ana.id,
      A({
        llmIntegrationId: llm.id,
        ttsIntegrationId: fish.id,
        sttIntegrationId: fish.id,
        llmModel: 'qwen/qwen3',
      }),
      null,
    );
    expect((await agentForWorker(db(), KEY, ana.id))?.llm?.model).toBe('qwen/qwen3');
    expect(await agentForWorker(db(), null, ana.id)).toMatchObject({ llm: null, tts: null, stt: null });

    expect((await listIntegrations(db(), admin)).find((i) => i.id === llm.id)?.usedBy).toBe(1);
    await deleteIntegration(db(), admin, llm.id, null);
    expect(await agentForWorker(db(), KEY, ana.id)).toMatchObject({ llm: null, llmModel: 'qwen/qwen3' });
  });

  it('speak with one provider and listen with another, in any combination', async () => {
    const { admin } = await org('acme');
    const llm = await createIntegration(deps(), admin, LLM(), null);
    const deepgram = await createIntegration(deps(), admin, DEEPGRAM(), null);
    const eleven = await createIntegration(deps(), admin, ELEVEN(), null);
    expect(deepgram).toMatchObject({ kind: 'deepgram', baseUrl: null, defaultModel: null });

    const mixed = await createAgent(
      db(),
      admin,
      A({
        llmIntegrationId: llm.id,
        ttsIntegrationId: eleven.id,
        ttsModel: 'eleven_flash_v2_5',
        voices: { pt: 'EXAVITQu4vr4xnSDxMaL' },
        sttIntegrationId: deepgram.id,
        sttModel: 'flux-general-multi',
      }),
      null,
    );
    expect(mixed.ready).toBe(true);
    expect(await agentForWorker(db(), KEY, mixed.id)).toMatchObject({
      tts: { provider: 'elevenlabs', apiKey: 'el-0123456789abcdef' },
      stt: { provider: 'deepgram', apiKey: 'dg-0123456789abcdef' },
      ttsModel: 'eleven_flash_v2_5',
      sttModel: 'flux-general-multi',
    });

    const reversed = A({
      name: 'Bia',
      llmIntegrationId: llm.id,
      ttsIntegrationId: deepgram.id,
      ttsModel: 'flux',
      voices: { pt: 'flux-bianca-pt', es: 'flux-valentina-es' },
      sttIntegrationId: eleven.id,
      sttModel: 'scribe_v2_realtime',
    });
    expect((await createAgent(db(), admin, reversed, null)).ready).toBe(true);

    // Models and voices must belong to the provider chosen for each direction.
    await expectAppError(
      createAgent(db(), admin, A({ ...reversed, name: 'C', ttsModel: 's2.1-pro' }), null),
      400,
    );
    await expectAppError(
      createAgent(db(), admin, A({ ...reversed, name: 'C', sttModel: 'transcribe-stream-1' }), null),
      400,
    );
    await expectAppError(
      createAgent(db(), admin, A({ ...reversed, name: 'C', voices: { pt: 'aura-2-celeste-es' } }), null),
      400,
    );
    expect((await listIntegrations(db(), admin)).find((i) => i.id === deepgram.id)?.usedBy).toBe(2);
  });

  it('tests Deepgram and ElevenLabs keys with each provider own auth header', async () => {
    const { admin } = await org('acme');
    const deepgram = await createIntegration(deps(), admin, DEEPGRAM(), null);
    const eleven = await createIntegration(deps(), admin, ELEVEN(), null);
    const seen: string[] = [];
    const ok = (async (url: string, init: RequestInit) => {
      const h = new Headers(init.headers);
      seen.push(`${url} ${h.get('authorization') ?? ''}${h.get('xi-api-key') ?? ''}`);
      return Response.json({});
    }) as unknown as Fetch;
    expect((await testIntegration(deps(ok), admin, deepgram.id)).ok).toBe(true);
    expect((await testIntegration(deps(ok), admin, eleven.id)).ok).toBe(true);
    expect(seen).toEqual([
      'https://api.deepgram.com/v1/projects Token dg-0123456789abcdef',
      'https://api.elevenlabs.io/v1/models el-0123456789abcdef',
    ]);
  });
});
