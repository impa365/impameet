import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { audit } from '../audit';
import type { SessionUser } from '../auth/session';
import type { Sql } from '../db';
import { AppError, badRequest, conflict, forbidden, notFound, tooManyRequests } from '../errors';
import { integrationSecret } from '../integrations/service';
import { agentInRoom } from '../moderation/agent';
import { RateLimiter } from '../security/rate-limit';
import type { NetPolicy } from '../tools/net';
import type { knowledgeBaseInput, knowledgeSourceInput } from '../validation';
import { type Embed, type EmbeddingConfig, fetchPage } from './ingest';
import { type VectorStore, collectionName } from './qdrant';
import { chunkText, contentHash, sparseVector } from './text';

export type KnowledgeBaseInput = z.infer<typeof knowledgeBaseInput>;
export type KnowledgeSourceInput = z.infer<typeof knowledgeSourceInput>;

/** Everything that talks to the outside, injectable in tests. */
export interface KnowledgeDeps {
  sql: Sql;
  key: Buffer | null;
  net: NetPolicy;
  /** Null when this installation has no Qdrant: knowledge bases are then unavailable. */
  store: VectorStore | null;
  embedder: (config: EmbeddingConfig) => Embed;
}

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string;
  embeddingIntegrationId: string | null;
  embeddingModel: string;
  dimensions: number;
  sources: number;
  chunks: number;
  agents: number;
  createdAt: Date;
}

export interface KnowledgeSource {
  id: string;
  kind: 'text' | 'file' | 'url' | 'qa';
  title: string;
  url: string | null;
  fileName: string | null;
  status: 'queued' | 'processing' | 'ready' | 'failed';
  error: string | null;
  chunkCount: number;
  enabled: boolean;
  chars: number;
  createdAt: Date;
  processedAt: Date | null;
}

export interface KnowledgeHit {
  base: string;
  title: string;
  section: string;
  content: string;
}

export const MAX_BASES = 20;
export const MAX_SOURCES = 500;
const MAX_CHUNKS_PER_SOURCE = 5000;
const STUCK_MS = 15 * 60_000;
const searches = new RateLimiter(60, 60_000);

function assertAdmin(user: SessionUser): void {
  if (user.role !== 'admin') throw forbidden('Só administradores gerenciam a base de conhecimento');
}

function needStore(deps: KnowledgeDeps): VectorStore {
  if (!deps.store || !deps.key)
    throw new AppError(501, 'knowledge_disabled', 'A base de conhecimento não está instalada neste servidor');
  return deps.store;
}

const BASE_COLUMNS = (sql: Sql) => sql`
  b.id, b.name, b.description, b.embedding_integration_id as "embeddingIntegrationId",
  b.embedding_model as "embeddingModel", b.dimensions, b.created_at as "createdAt",
  (select count(*)::int from knowledge_sources s where s.kb_id = b.id) as sources,
  (select coalesce(sum(chunk_count), 0)::int from knowledge_sources s where s.kb_id = b.id and s.enabled) as chunks,
  (select count(*)::int from agent_knowledge ak where ak.kb_id = b.id) as agents`;

const SOURCE_COLUMNS = (sql: Sql) => sql`
  id, kind, title, url, file_name as "fileName", status, error, chunk_count as "chunkCount", enabled,
  char_length(content) as chars, created_at as "createdAt", processed_at as "processedAt"`;

export async function listBases(sql: Sql, user: SessionUser): Promise<KnowledgeBase[]> {
  assertAdmin(user);
  return sql<KnowledgeBase[]>`
    select ${BASE_COLUMNS(sql)} from knowledge_bases b where b.tenant_id = ${user.tenantId} order by b.name`;
}

async function baseRow(sql: Sql, tenantId: string, id: string) {
  const [row] = await sql<
    {
      id: string;
      name: string;
      collection: string;
      integrationId: string | null;
      model: string;
      dimensions: number;
    }[]
  >`
    select id, name, collection, embedding_integration_id as "integrationId", embedding_model as model, dimensions
    from knowledge_bases where id = ${id} and tenant_id = ${tenantId}`;
  if (!row) throw notFound('Base de conhecimento não encontrada');
  return row;
}

/** The embedding settings of an integration of this organization (kind "embedding"). */
async function embeddingConfig(deps: KnowledgeDeps, tenantId: string, integrationId: string | null) {
  if (!integrationId) throw badRequest('Escolha a integração de embeddings da base');
  const secret = await integrationSecret(deps.sql, deps.key!, tenantId, integrationId);
  if (secret.kind !== 'embedding' || !secret.baseUrl || !secret.defaultModel)
    throw badRequest('Escolha uma integração de embeddings');
  return { baseUrl: secret.baseUrl, apiKey: secret.apiKey, model: secret.defaultModel };
}

export async function createBase(
  deps: KnowledgeDeps,
  actor: SessionUser,
  input: KnowledgeBaseInput,
  ip: string | null,
): Promise<KnowledgeBase> {
  assertAdmin(actor);
  const store = needStore(deps);
  const [{ count }] = await deps.sql<{ count: number }[]>`
    select count(*)::int as count from knowledge_bases where tenant_id = ${actor.tenantId}`;
  if (count >= MAX_BASES) throw badRequest(`Até ${MAX_BASES} bases de conhecimento por organização`);
  const config = await embeddingConfig(deps, actor.tenantId, input.embeddingIntegrationId);
  let dimensions: number;
  try {
    [{ length: dimensions }] = await deps.embedder(config)(['teste']);
  } catch (err) {
    throw badRequest(`Não foi possível gerar embeddings: ${err instanceof Error ? err.message : 'erro'}`);
  }
  const id = randomUUID();
  const collection = collectionName(id);
  await store.ensureCollection(collection, dimensions);
  try {
    await deps.sql`
      insert into knowledge_bases (id, tenant_id, name, description, embedding_integration_id, embedding_model,
                                   dimensions, collection, created_by)
      values (${id}, ${actor.tenantId}, ${input.name}, ${input.description}, ${input.embeddingIntegrationId},
              ${config.model}, ${dimensions}, ${collection}, ${actor.id})`;
  } catch (err) {
    await store.dropCollection(collection).catch(() => undefined);
    if ((err as { code?: string }).code === '23505') throw conflict('Já existe uma base com esse nome');
    throw err;
  }
  await audit(deps.sql, {
    tenantId: actor.tenantId,
    actorId: actor.id,
    action: 'knowledge.created',
    target: input.name,
    ip,
  });
  const [base] = await deps.sql<
    KnowledgeBase[]
  >`select ${BASE_COLUMNS(deps.sql)} from knowledge_bases b where b.id = ${id}`;
  return base;
}

/** Name and description only: the embedding model of a base never changes (its vectors depend on it). */
export async function renameBase(
  sql: Sql,
  actor: SessionUser,
  id: string,
  input: Pick<KnowledgeBaseInput, 'name' | 'description'>,
): Promise<void> {
  assertAdmin(actor);
  await baseRow(sql, actor.tenantId, id);
  try {
    await sql`update knowledge_bases set name = ${input.name}, description = ${input.description}, updated_at = now()
              where id = ${id} and tenant_id = ${actor.tenantId}`;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw conflict('Já existe uma base com esse nome');
    throw err;
  }
}

export async function deleteBase(deps: KnowledgeDeps, actor: SessionUser, id: string, ip: string | null) {
  assertAdmin(actor);
  const base = await baseRow(deps.sql, actor.tenantId, id);
  await needStore(deps).dropCollection(base.collection);
  await deps.sql`delete from knowledge_bases where id = ${id}`;
  await audit(deps.sql, {
    tenantId: actor.tenantId,
    actorId: actor.id,
    action: 'knowledge.deleted',
    target: base.name,
    ip,
  });
}

export async function listSources(
  deps: KnowledgeDeps,
  actor: SessionUser,
  kbId: string,
): Promise<KnowledgeSource[]> {
  assertAdmin(actor);
  await baseRow(deps.sql, actor.tenantId, kbId);
  // Picks up what a restart interrupted.
  const stuck = await deps.sql<{ id: string }[]>`
    update knowledge_sources set status = 'queued'
    where kb_id = ${kbId} and status = 'processing' and updated_at < now() - ${`${STUCK_MS} milliseconds`}::interval
    returning id`;
  const queued = await deps.sql<{ id: string }[]>`
    select id from knowledge_sources where kb_id = ${kbId} and status = 'queued'`;
  for (const { id } of [...stuck, ...queued]) void processSource(deps, id);
  return deps.sql<KnowledgeSource[]>`
    select ${SOURCE_COLUMNS(deps.sql)} from knowledge_sources where kb_id = ${kbId} order by created_at desc`;
}

/** Text, Q&A and links are added here; files arrive already read (see `addFile`). */
export async function addSource(
  deps: KnowledgeDeps,
  actor: SessionUser,
  kbId: string,
  input: KnowledgeSourceInput,
  ip: string | null,
): Promise<{ id: string; done: Promise<void> }> {
  assertAdmin(actor);
  needStore(deps);
  await baseRow(deps.sql, actor.tenantId, kbId);
  const [{ count }] = await deps.sql<{ count: number }[]>`
    select count(*)::int as count from knowledge_sources where kb_id = ${kbId}`;
  if (count >= MAX_SOURCES) throw badRequest(`Até ${MAX_SOURCES} fontes por base`);
  const content =
    input.kind === 'text'
      ? input.content
      : input.kind === 'qa'
        ? input.pairs.map((p) => `## ${p.question}\n\n${p.answer}`).join('\n\n')
        : '';
  const title =
    input.kind === 'url' ? input.title || new URL(input.url).host + new URL(input.url).pathname : input.title;
  const [{ id }] = await deps.sql<{ id: string }[]>`
    insert into knowledge_sources (tenant_id, kb_id, kind, title, url, content, created_by)
    values (${actor.tenantId}, ${kbId}, ${input.kind}, ${title.slice(0, 200)},
            ${input.kind === 'url' ? input.url : null}, ${content}, ${actor.id})
    returning id`;
  await audit(deps.sql, {
    tenantId: actor.tenantId,
    actorId: actor.id,
    action: 'knowledge.source.added',
    target: title.slice(0, 200),
    meta: { kind: input.kind },
    ip,
  });
  return { id, done: processSource(deps, id) };
}

export async function addFile(
  deps: KnowledgeDeps,
  actor: SessionUser,
  kbId: string,
  file: { name: string; text: string },
  ip: string | null,
): Promise<{ id: string; done: Promise<void> }> {
  assertAdmin(actor);
  needStore(deps);
  await baseRow(deps.sql, actor.tenantId, kbId);
  const [{ id }] = await deps.sql<{ id: string }[]>`
    insert into knowledge_sources (tenant_id, kb_id, kind, title, file_name, content, created_by)
    values (${actor.tenantId}, ${kbId}, 'file', ${file.name.slice(0, 200)}, ${file.name.slice(0, 255)},
            ${file.text}, ${actor.id})
    returning id`;
  await audit(deps.sql, {
    tenantId: actor.tenantId,
    actorId: actor.id,
    action: 'knowledge.source.added',
    target: file.name.slice(0, 200),
    meta: { kind: 'file' },
    ip,
  });
  return { id, done: processSource(deps, id) };
}

/**
 * Reads (links), cuts, embeds and indexes one source. Only one run per source at a time (the
 * status flip is the lock); unchanged text is not embedded again. Errors end up on the source.
 */
export async function processSource(deps: KnowledgeDeps, id: string): Promise<void> {
  const { sql } = deps;
  const [source] = await sql<
    {
      id: string;
      tenantId: string;
      kbId: string;
      kind: string;
      title: string;
      url: string | null;
      content: string;
      contentHash: string;
      chunkCount: number;
      enabled: boolean;
    }[]
  >`
    update knowledge_sources set status = 'processing', error = null, updated_at = now()
    where id = ${id} and status = 'queued'
    returning id, tenant_id as "tenantId", kb_id as "kbId", kind, title, url, content,
              content_hash as "contentHash", chunk_count as "chunkCount", enabled`;
  if (!source) return;
  try {
    const store = needStore(deps);
    const base = await baseRow(sql, source.tenantId, source.kbId);
    let text = source.content;
    if (source.kind === 'url' && source.url) {
      const page = await fetchPage(source.url, deps.net);
      text = page.text;
      await sql`update knowledge_sources set content = ${text} where id = ${id}`;
    }
    if (!text.trim()) throw new Error('A fonte não tem texto');
    const hash = await contentHash(text);
    if (hash === source.contentHash && source.chunkCount > 0) {
      await sql`update knowledge_sources set status = 'ready', processed_at = now(), updated_at = now() where id = ${id}`;
      return;
    }
    const pieces = chunkText(text).slice(0, MAX_CHUNKS_PER_SOURCE);
    const config = await embeddingConfig(deps, source.tenantId, base.integrationId);
    const vectors = await deps.embedder(config)(pieces.map((p) => p.content));
    if (vectors.some((v) => v.length !== base.dimensions))
      throw new Error('O modelo de embeddings mudou de tamanho: crie uma base nova para ele');
    await store.deleteSource(base.collection, id);
    const ids = pieces.map(() => randomUUID());
    await store.upsert(
      base.collection,
      pieces.map((p, i) => ({
        id: ids[i],
        dense: vectors[i],
        sparse: sparseVector(p.content),
        payload: {
          tenant_id: source.tenantId,
          kb_id: source.kbId,
          source_id: id,
          title: source.title,
          section: p.section,
          idx: i,
          enabled: source.enabled,
          content: p.content,
        },
      })),
    );
    await sql.begin(async (tx) => {
      await tx`delete from knowledge_chunks where source_id = ${id}`;
      for (let i = 0; i < pieces.length; i += 500) {
        const rows = pieces.slice(i, i + 500).map((p, j) => ({
          id: ids[i + j],
          tenant_id: source.tenantId,
          kb_id: source.kbId,
          source_id: id,
          idx: i + j,
          section: p.section,
          content: p.content,
        }));
        await tx`insert into knowledge_chunks ${tx(rows)}`;
      }
      await tx`update knowledge_sources set status = 'ready', chunk_count = ${pieces.length}, content_hash = ${hash},
                 processed_at = now(), updated_at = now() where id = ${id}`;
    });
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 300) : 'erro';
    await sql`update knowledge_sources set status = 'failed', error = ${message}, updated_at = now() where id = ${id}`;
  }
}

async function sourceRow(sql: Sql, tenantId: string, kbId: string, id: string) {
  const [row] = await sql<{ id: string; title: string }[]>`
    select id, title from knowledge_sources where id = ${id} and kb_id = ${kbId} and tenant_id = ${tenantId}`;
  if (!row) throw notFound('Fonte não encontrada');
  return row;
}

export async function reprocessSource(deps: KnowledgeDeps, actor: SessionUser, kbId: string, id: string) {
  assertAdmin(actor);
  await sourceRow(deps.sql, actor.tenantId, kbId, id);
  await deps.sql`update knowledge_sources set status = 'queued', content_hash = '' where id = ${id} and status <> 'processing'`;
  return processSource(deps, id);
}

export async function setSourceEnabled(
  deps: KnowledgeDeps,
  actor: SessionUser,
  kbId: string,
  id: string,
  enabled: boolean,
) {
  assertAdmin(actor);
  const base = await baseRow(deps.sql, actor.tenantId, kbId);
  await sourceRow(deps.sql, actor.tenantId, kbId, id);
  await needStore(deps).setSourceEnabled(base.collection, id, enabled);
  await deps.sql`update knowledge_sources set enabled = ${enabled}, updated_at = now() where id = ${id}`;
}

export async function deleteSource(
  deps: KnowledgeDeps,
  actor: SessionUser,
  kbId: string,
  id: string,
  ip: string | null,
) {
  assertAdmin(actor);
  const base = await baseRow(deps.sql, actor.tenantId, kbId);
  const source = await sourceRow(deps.sql, actor.tenantId, kbId, id);
  await needStore(deps).deleteSource(base.collection, id);
  await deps.sql`delete from knowledge_sources where id = ${id}`;
  await audit(deps.sql, {
    tenantId: actor.tenantId,
    actorId: actor.id,
    action: 'knowledge.source.deleted',
    target: source.title,
    ip,
  });
}

/** Hybrid search in each base, then one list fused by rank (RRF) across bases. */
export async function searchBases(
  deps: KnowledgeDeps,
  tenantId: string,
  kbIds: string[],
  query: string,
  limit = 5,
): Promise<KnowledgeHit[]> {
  const store = needStore(deps);
  const lists: { hit: KnowledgeHit; key: string }[][] = [];
  for (const kbId of kbIds) {
    const base = await baseRow(deps.sql, tenantId, kbId).catch(() => null);
    if (!base) continue;
    const config = await embeddingConfig(deps, tenantId, base.integrationId);
    const [dense] = await deps.embedder(config)([query]);
    const hits = await store.search(base.collection, tenantId, dense, sparseVector(query), limit * 2);
    lists.push(
      hits
        .filter((h) => h.payload.tenant_id === tenantId)
        .map((h) => ({
          key: h.id,
          hit: {
            base: base.name,
            title: h.payload.title,
            section: h.payload.section,
            content: h.payload.content,
          },
        })),
    );
  }
  const scores = new Map<string, { hit: KnowledgeHit; score: number }>();
  for (const list of lists)
    list.forEach(({ hit, key }, rank) => {
      const current = scores.get(key) ?? { hit, score: 0 };
      current.score += 1 / (60 + rank + 1);
      scores.set(key, current);
    });
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.hit);
}

/** Admin "test the search" box. */
export async function testSearch(deps: KnowledgeDeps, actor: SessionUser, kbId: string, query: string) {
  assertAdmin(actor);
  await baseRow(deps.sql, actor.tenantId, kbId);
  return searchBases(deps, actor.tenantId, [kbId], query);
}

/** The agent's lookup during a meeting: only the bases the admin linked to it. */
export async function agentSearch(
  deps: KnowledgeDeps,
  agentId: string,
  lkRoom: string,
  query: string,
): Promise<KnowledgeHit[]> {
  const { agent } = await agentInRoom(deps.sql, agentId, lkRoom);
  if (!searches.take(`${agent.id}:${lkRoom}`)) throw tooManyRequests();
  const rows = await deps.sql<{ kbId: string }[]>`
    select kb_id as "kbId" from agent_knowledge ak join knowledge_bases b on b.id = ak.kb_id
    where ak.agent_id = ${agent.id} and b.tenant_id = ${agent.tenantId}`;
  if (rows.length === 0) return [];
  return searchBases(
    deps,
    agent.tenantId,
    rows.map((r) => r.kbId),
    query,
  );
}

/** Only this organization's bases can be linked to its agents. */
export async function assertTenantBases(sql: Sql, tenantId: string, kbIds: string[]): Promise<void> {
  const unique = [...new Set(kbIds)];
  if (unique.length === 0) return;
  const found = await sql<{ id: string }[]>`
    select id from knowledge_bases where tenant_id = ${tenantId} and id in ${sql(unique)}`;
  if (found.length !== unique.length) throw badRequest('Base de conhecimento não encontrada');
}

/** Which bases an agent uses. */
export async function setAgentBases(
  sql: Sql,
  tenantId: string,
  agentId: string,
  kbIds: string[],
): Promise<void> {
  const unique = [...new Set(kbIds)];
  await assertTenantBases(sql, tenantId, unique);
  await sql`delete from agent_knowledge where agent_id = ${agentId}`;
  for (const kbId of unique)
    await sql`insert into agent_knowledge (agent_id, kb_id) values (${agentId}, ${kbId})`;
}
