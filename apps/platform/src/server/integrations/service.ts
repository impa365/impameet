import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { audit } from '../audit';
import type { SessionUser } from '../auth/session';
import type { Sql } from '../db';
import { badRequest, conflict, forbidden, notFound } from '../errors';
import { type Resolver, assertPublicHttpsUrl, systemResolver } from '../security/public-url';
import { openSecret, sealSecret, secretHint } from '../security/secrets';
import type { integrationInput, modelDiscoveryInput } from '../validation';
import { isRerankModel, modelCategory } from '@/lib/models';
import { type SpeechProvider, isSpeechProvider } from '@/lib/providers';
import {
  type Fetch,
  type ProbeResult,
  probeDeepgram,
  probeElevenLabs,
  probeEmbedding,
  probeFish,
  probeLlm,
  probeRerank,
} from './probe';
import { type VoiceQuery, type VoicesResult, fetchVoices } from './voices';

export type IntegrationKind = 'llm' | 'embedding' | 'rerank' | SpeechProvider;
/** What an OpenAI-compatible integration proved it can do in its last "Testar conexão". */
export type Capability = 'chat' | 'embeddings' | 'rerank';
export type IntegrationInput = z.infer<typeof integrationInput>;
export type ModelDiscoveryInput = z.infer<typeof modelDiscoveryInput>;

export interface Integration {
  id: string;
  kind: IntegrationKind;
  name: string;
  baseUrl: string | null;
  defaultModel: string | null;
  models: string[];
  secretHint: string;
  lastTestedAt: Date | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
  capabilities: Capability[];
  usedBy: number;
  /** Knowledge bases that embed or rerank with it. */
  usedByBases: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Everything that touches secrets or the network, injectable in tests. */
export interface IntegrationDeps {
  sql: Sql;
  key: Buffer;
  resolve?: Resolver;
  fetch?: Fetch;
}

const COLUMNS = (sql: Sql) => sql`
  i.id, i.kind, i.name, i.base_url as "baseUrl", i.default_model as "defaultModel", i.models,
  i.secret_hint as "secretHint", i.last_tested_at as "lastTestedAt", i.last_test_ok as "lastTestOk",
  i.last_test_error as "lastTestError", i.created_at as "createdAt", i.updated_at as "updatedAt",
  i.capabilities,
  (select count(*)::int from agents a
    where a.llm_integration_id = i.id or a.tts_integration_id = i.id
       or a.stt_integration_id = i.id) as "usedBy",
  (select count(*)::int from knowledge_bases b
    where b.embedding_integration_id = i.id or b.rerank_integration_id = i.id) as "usedByBases"`;

/** Ties each ciphertext to its organization and record. */
const aad = (tenantId: string, id: string) => `integration:${tenantId}:${id}`;

function assertAdmin(user: SessionUser): void {
  if (user.role !== 'admin') throw forbidden('Só administradores gerenciam integrações');
}

const isUniqueViolation = (err: unknown) => (err as { code?: string }).code === '23505';

/** A saved key is only ever sent to the host it was saved for. */
const NEW_HOST_NEEDS_KEY = 'Ao trocar o endereço da API, informe a chave de novo';
const sameOrigin = (a: string | null, b: string | null) =>
  a === b || (!!a && !!b && new URL(a).origin === new URL(b).origin);

export async function listIntegrations(sql: Sql, user: SessionUser): Promise<Integration[]> {
  assertAdmin(user);
  return sql<Integration[]>`
    select ${COLUMNS(sql)} from integrations i
    where i.tenant_id = ${user.tenantId} order by i.kind, i.name`;
}

async function findIntegration(sql: Sql, tenantId: string, id: string): Promise<Integration> {
  const [row] = await sql<Integration[]>`
    select ${COLUMNS(sql)} from integrations i where i.id = ${id} and i.tenant_id = ${tenantId}`;
  if (!row) throw notFound('Integração não encontrada');
  return row;
}

async function fields(deps: IntegrationDeps, input: IntegrationInput) {
  if (input.kind === 'embedding' || input.kind === 'rerank') {
    const baseUrl = await assertPublicHttpsUrl(input.baseUrl, deps.resolve ?? systemResolver);
    return { baseUrl, defaultModel: input.defaultModel, models: [input.defaultModel] };
  }
  if (input.kind !== 'llm') return { baseUrl: null, defaultModel: null, models: [] as string[] };
  const baseUrl = await assertPublicHttpsUrl(input.baseUrl, deps.resolve ?? systemResolver);
  const models = [...new Set([input.defaultModel, ...input.models])];
  return { baseUrl, defaultModel: input.defaultModel, models };
}

export async function createIntegration(
  deps: IntegrationDeps,
  actor: SessionUser,
  input: IntegrationInput,
  ip: string | null,
): Promise<Integration> {
  assertAdmin(actor);
  if (!input.apiKey) throw badRequest('Informe a chave de API');
  const { sql } = deps;
  const id = randomUUID();
  const f = await fields(deps, input);
  const sealed = sealSecret(deps.key, input.apiKey, aad(actor.tenantId, id));
  try {
    await sql`
      insert into integrations (id, tenant_id, kind, name, base_url, default_model, models,
                                secret_sealed, secret_hint, created_by)
      values (${id}, ${actor.tenantId}, ${input.kind}, ${input.name}, ${f.baseUrl}, ${f.defaultModel},
              ${f.models}, ${sealed}, ${secretHint(input.apiKey)}, ${actor.id})`;
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('Já existe uma integração com esse nome');
    throw err;
  }
  await audit(sql, {
    tenantId: actor.tenantId,
    actorId: actor.id,
    action: 'integration.created',
    target: input.name,
    ip,
  });
  return findIntegration(sql, actor.tenantId, id);
}

/** Leaving the key empty keeps the saved one. The kind of an integration never changes. */
export async function updateIntegration(
  deps: IntegrationDeps,
  actor: SessionUser,
  id: string,
  input: IntegrationInput,
  ip: string | null,
): Promise<Integration> {
  assertAdmin(actor);
  const { sql } = deps;
  const current = await findIntegration(sql, actor.tenantId, id);
  if (current.kind !== input.kind) throw badRequest('Não é possível mudar o tipo da integração');
  const f = await fields(deps, input);
  if (!input.apiKey && !sameOrigin(current.baseUrl, f.baseUrl)) throw badRequest(NEW_HOST_NEEDS_KEY);
  const sealed = input.apiKey ? sealSecret(deps.key, input.apiKey, aad(actor.tenantId, id)) : null;
  try {
    await sql`
      update integrations set name = ${input.name}, base_url = ${f.baseUrl},
        default_model = ${f.defaultModel}, models = ${f.models},
        secret_sealed = coalesce(${sealed}, secret_sealed),
        secret_hint = coalesce(${input.apiKey ? secretHint(input.apiKey) : null}, secret_hint),
        last_test_ok = case when ${sealed !== null}::boolean then null else last_test_ok end,
        capabilities = case when ${sealed !== null}::boolean then '{}' else capabilities end,
        updated_at = now()
      where id = ${id} and tenant_id = ${actor.tenantId}`;
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('Já existe uma integração com esse nome');
    throw err;
  }
  await audit(sql, {
    tenantId: actor.tenantId,
    actorId: actor.id,
    action: 'integration.updated',
    target: input.name,
    ip,
  });
  return findIntegration(sql, actor.tenantId, id);
}

/** Agents using it become incomplete (and stay out of meetings) until another one is chosen. */
export async function deleteIntegration(
  sql: Sql,
  actor: SessionUser,
  id: string,
  ip: string | null,
): Promise<void> {
  assertAdmin(actor);
  const [row] = await sql<{ name: string }[]>`
    delete from integrations where id = ${id} and tenant_id = ${actor.tenantId} returning name`;
  if (!row) throw notFound('Integração não encontrada');
  await audit(sql, {
    tenantId: actor.tenantId,
    actorId: actor.id,
    action: 'integration.deleted',
    target: row.name,
    ip,
  });
}

/** The decrypted key, for server-side use only (probe, voice worker). */
export async function integrationSecret(
  sql: Sql,
  key: Buffer,
  tenantId: string,
  id: string,
): Promise<{
  kind: IntegrationKind;
  baseUrl: string | null;
  defaultModel: string | null;
  models: string[];
  apiKey: string;
}> {
  const [row] = await sql<
    {
      kind: IntegrationKind;
      baseUrl: string | null;
      defaultModel: string | null;
      models: string[];
      sealed: string;
    }[]
  >`
    select kind, base_url as "baseUrl", default_model as "defaultModel", models, secret_sealed as sealed
    from integrations where id = ${id} and tenant_id = ${tenantId}`;
  if (!row) throw notFound('Integração não encontrada');
  return {
    kind: row.kind,
    baseUrl: row.baseUrl,
    defaultModel: row.defaultModel,
    models: row.models,
    apiKey: openSecret(key, row.sealed, aad(tenantId, id)),
  };
}

/**
 * What an OpenAI-compatible key can do beyond chat, proved with a real call to the first model
 * of each kind the admin enabled in it (nothing is assumed from a name alone).
 */
async function extraCapabilities(
  fetchImpl: Fetch,
  baseUrl: string,
  apiKey: string,
  models: readonly string[],
): Promise<Capability[]> {
  const found: Capability[] = [];
  const embedding = models.find((m) => modelCategory(m) === 'embedding');
  if (embedding && (await probeEmbedding(fetchImpl, baseUrl, apiKey, embedding)).ok) found.push('embeddings');
  const reranker = models.find(isRerankModel);
  if (reranker && (await probeRerank(fetchImpl, baseUrl, apiKey, reranker)).ok) found.push('rerank');
  return found;
}

/** "Testar conexão": checks the key live and records the outcome (models are returned, not saved). */
export async function testIntegration(
  deps: IntegrationDeps,
  actor: SessionUser,
  id: string,
): Promise<ProbeResult> {
  assertAdmin(actor);
  const secret = await integrationSecret(deps.sql, deps.key, actor.tenantId, id);
  const fetchImpl = deps.fetch ?? fetch;
  let result: ProbeResult;
  let capabilities: Capability[] = [];
  if (secret.kind === 'llm') {
    const baseUrl = await assertPublicHttpsUrl(secret.baseUrl ?? '', deps.resolve ?? systemResolver);
    result = await probeLlm(fetchImpl, baseUrl, secret.apiKey);
    if (result.ok)
      capabilities = ['chat', ...(await extraCapabilities(fetchImpl, baseUrl, secret.apiKey, secret.models))];
  } else if (secret.kind === 'embedding') {
    const baseUrl = await assertPublicHttpsUrl(secret.baseUrl ?? '', deps.resolve ?? systemResolver);
    result = await probeEmbedding(fetchImpl, baseUrl, secret.apiKey, secret.defaultModel ?? '');
    if (result.ok) capabilities = ['embeddings'];
  } else if (secret.kind === 'rerank') {
    const baseUrl = await assertPublicHttpsUrl(secret.baseUrl ?? '', deps.resolve ?? systemResolver);
    result = await probeRerank(fetchImpl, baseUrl, secret.apiKey, secret.defaultModel ?? '');
    if (result.ok) capabilities = ['rerank'];
  } else if (secret.kind === 'deepgram') {
    result = await probeDeepgram(fetchImpl, secret.apiKey);
  } else if (secret.kind === 'elevenlabs') {
    result = await probeElevenLabs(fetchImpl, secret.apiKey);
  } else {
    result = await probeFish(fetchImpl, secret.apiKey);
  }
  await deps.sql`
    update integrations set last_tested_at = now(), last_test_ok = ${result.ok},
      last_test_error = ${result.ok ? null : result.error}, capabilities = ${capabilities}
    where id = ${id} and tenant_id = ${actor.tenantId}`;
  return result.ok ? { ...result, capabilities } : result;
}

/** "Buscar modelos" while filling the form, before anything is saved (nothing is recorded). */
export async function discoverModels(
  deps: IntegrationDeps,
  actor: SessionUser,
  input: ModelDiscoveryInput,
): Promise<ProbeResult> {
  assertAdmin(actor);
  const baseUrl = await assertPublicHttpsUrl(input.baseUrl, deps.resolve ?? systemResolver);
  let apiKey = input.apiKey;
  if (!apiKey) {
    if (!input.integrationId) throw badRequest('Informe a chave de API');
    const saved = await integrationSecret(deps.sql, deps.key, actor.tenantId, input.integrationId);
    if (saved.kind !== input.kind) throw badRequest('Não é possível mudar o tipo da integração');
    if (!sameOrigin(saved.baseUrl, baseUrl)) throw badRequest(NEW_HOST_NEEDS_KEY);
    apiKey = saved.apiKey;
  }
  const fetchImpl = deps.fetch ?? fetch;
  // Routers such as 9router and OmniRoute keep embedding models out of /models, on
  // /models/embedding; asked for both kinds, since one LLM key may also embed.
  const [listed, dedicated] = await Promise.all([
    probeLlm(fetchImpl, baseUrl, apiKey),
    probeLlm(fetchImpl, baseUrl, apiKey, '/models/embedding'),
  ]);
  if (!dedicated.ok || dedicated.models.length === 0) return listed;
  const others = listed.ok ? listed.models : [];
  const embeddings = [...new Set([...dedicated.models, ...((listed.ok && listed.embeddings) || [])])];
  const rerankers = listed.ok ? listed.rerankers : undefined;
  return {
    ok: true,
    models: [...new Set([...dedicated.models, ...others])],
    embeddings,
    ...(rerankers ? { rerankers } : {}),
  };
}

/** The voices of a saved speech key (Fish Audio, Deepgram or ElevenLabs), for the agent form. */
export async function listVoices(
  deps: IntegrationDeps,
  actor: SessionUser,
  id: string,
  query: VoiceQuery,
): Promise<VoicesResult> {
  assertAdmin(actor);
  const secret = await integrationSecret(deps.sql, deps.key, actor.tenantId, id);
  if (!isSpeechProvider(secret.kind))
    throw badRequest('Escolha uma integração de voz (Fish Audio, Deepgram ou ElevenLabs)');
  return fetchVoices(deps.fetch ?? fetch, secret.kind, secret.apiKey, query);
}

async function integrationKind(sql: Sql, tenantId: string, id: string): Promise<string> {
  const [row] = await sql<{ kind: string }[]>`
    select kind from integrations where id = ${id} and tenant_id = ${tenantId}`;
  if (!row) throw notFound('Integração não encontrada');
  return row.kind;
}

/** An agent may only use this organization's integrations, of the right kind. */
export async function assertTenantIntegration(
  sql: Sql,
  tenantId: string,
  id: string | null,
  kind: 'llm',
): Promise<void> {
  if (!id) return;
  if ((await integrationKind(sql, tenantId, id)) !== kind) throw badRequest('Escolha uma integração de LLM');
}

/** A speech provider of this organization (Fish Audio, Deepgram or ElevenLabs), for TTS or STT. */
export async function speechIntegrationKind(sql: Sql, tenantId: string, id: string): Promise<SpeechProvider> {
  const kind = await integrationKind(sql, tenantId, id);
  if (!isSpeechProvider(kind))
    throw badRequest('Escolha uma integração de voz (Fish Audio, Deepgram ou ElevenLabs)');
  return kind;
}
