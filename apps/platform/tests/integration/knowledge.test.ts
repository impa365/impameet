import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createExample, deleteExample, listExamples, updateExample } from '@/server/agents/examples';
import { agentForWorker, listAgents, updateAgent } from '@/server/agents/service';
import { signup } from '@/server/auth/service';
import type { SessionUser } from '@/server/auth/session';
import type { Sql } from '@/server/db';
import { AppError } from '@/server/errors';
import { createIntegration } from '@/server/integrations/service';
import type { Embed } from '@/server/knowledge/ingest';
import {
  type VectorHit,
  type VectorPoint,
  type VectorStore,
  collectionName,
  qdrantStore,
} from '@/server/knowledge/qdrant';
import {
  type KnowledgeDeps,
  addFile,
  addSource,
  agentSearch,
  createBase,
  deleteBase,
  deleteSource,
  listBases,
  listSources,
  reprocessSource,
  setSourceEnabled,
  testSearch,
} from '@/server/knowledge/service';
import { keywords } from '@/server/knowledge/text';
import { createRoom } from '@/server/rooms/service';
import { hashPassword } from '@/server/security/password';
import {
  agentExampleInput,
  agentInput,
  createRoomInput,
  integrationInput,
  knowledgeBaseInput,
  knowledgeSourceInput,
} from '@/server/validation';
import { type TestSql, freshDatabase } from './db';
import { READY_AGENT_KEY, agentChoices } from './ready-agent';

let sql: TestSql;
const db = () => sql as unknown as Sql;
const PASSWORD = 'senha-muito-segura';
const DIMS = 32;

/** Deterministic "meaning" vectors: each word lights up one dimension (enough to rank by topic). */
function vectorOf(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const w of keywords(text)) {
    let h = 0;
    for (const c of w) h = (h * 31 + c.charCodeAt(0)) % DIMS;
    v[h] += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

let embedCalls = 0;
const embedder = (): Embed => async (texts) => {
  embedCalls += texts.length;
  return texts.map(vectorOf);
};

/** Qdrant stand-in: filters like the real one (tenant, enabled) and ranks by cosine. */
class MemoryStore implements VectorStore {
  collections = new Map<string, { dims: number; points: Map<string, VectorPoint> }>();
  async ensureCollection(name: string, dims: number) {
    if (!this.collections.has(name)) this.collections.set(name, { dims, points: new Map() });
  }
  async dropCollection(name: string) {
    this.collections.delete(name);
  }
  async upsert(name: string, points: VectorPoint[]) {
    const c = this.collections.get(name)!;
    for (const p of points) {
      expect(p.dense).toHaveLength(c.dims);
      c.points.set(p.id, structuredClone(p));
    }
  }
  async deleteSource(name: string, sourceId: string) {
    const c = this.collections.get(name);
    for (const [id, p] of c?.points ?? []) if (p.payload.source_id === sourceId) c!.points.delete(id);
  }
  async setSourceEnabled(name: string, sourceId: string, enabled: boolean) {
    for (const p of this.collections.get(name)?.points.values() ?? [])
      if (p.payload.source_id === sourceId) p.payload.enabled = enabled;
  }
  async search(
    name: string,
    tenantId: string,
    dense: number[],
    _sparse: unknown,
    limit: number,
  ): Promise<VectorHit[]> {
    return [...(this.collections.get(name)?.points.values() ?? [])]
      .filter((p) => p.payload.tenant_id === tenantId && p.payload.enabled)
      .map((p) => ({ id: p.id, score: p.dense.reduce((s, x, i) => s + x * dense[i], 0), payload: p.payload }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
  count(name: string) {
    return this.collections.get(name)?.points.size ?? 0;
  }
}

const pages: Record<string, string> = {
  '/precos':
    '<html><head><title>Preços</title></head><body><h1>Planos</h1><p>O plano Pro custa R$ 99 por mês.</p></body></html>',
};
let port = 0;
const server = http.createServer((req, res) => {
  const page = pages[req.url ?? ''];
  if (!page) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page);
});

let store: MemoryStore;
const deps = (): KnowledgeDeps => ({
  sql: db(),
  key: READY_AGENT_KEY,
  net: { privateHosts: new Set(['pages.test']), resolve: async () => ['127.0.0.1'] },
  store,
  embedder,
});

beforeAll(async () => {
  sql = await freshDatabase();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await sql?.end({ timeout: 5 });
});
beforeEach(async () => {
  await sql`truncate tenants, audit_log restart identity cascade`;
  store = new MemoryStore();
  embedCalls = 0;
});

async function expectAppError(promise: Promise<unknown>, status: number, message?: RegExp) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).status).toBe(status);
  if (message) expect((err as AppError).message).toMatch(message);
}

async function org(slug: string) {
  const { tenant, user: admin } = await signup(
    db(),
    { organization: `Org ${slug}`, slug, name: 'Admin', email: `admin@${slug}.test`, password: PASSWORD },
    null,
    'enterprise',
  );
  const embedding = await createIntegration(
    { sql: db(), key: READY_AGENT_KEY, resolve: async () => ['93.184.215.14'] },
    admin,
    integrationInput.parse({
      kind: 'embedding',
      name: 'Embeddings',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'emb-0123456789abcdef',
      defaultModel: 'text-embedding-3-small',
    }),
    null,
  );
  return { tenant, admin, embedding };
}

const settle = (promise: { done: Promise<void> }) => promise.done;

describe('knowledge bases', () => {
  it('needs an embedding integration, learns its size and indexes text, Q&A and pages', async () => {
    const { admin, embedding } = await org('acme');
    const choices = await agentChoices(db(), admin);
    await expectAppError(
      createBase(
        deps(),
        admin,
        knowledgeBaseInput.parse({ name: 'X', embeddingIntegrationId: choices.llmIntegrationId }),
        null,
      ),
      400,
      /embeddings/,
    );
    const base = await createBase(
      deps(),
      admin,
      knowledgeBaseInput.parse({ name: 'Produtos', embeddingIntegrationId: embedding.id }),
      null,
    );
    expect(base).toMatchObject({
      name: 'Produtos',
      embeddingModel: 'text-embedding-3-small',
      dimensions: DIMS,
      sources: 0,
    });
    expect(store.collections.has(collectionName(base.id))).toBe(true);
    await expectAppError(
      createBase(
        deps(),
        admin,
        knowledgeBaseInput.parse({ name: 'Produtos', embeddingIntegrationId: embedding.id }),
        null,
      ),
      409,
    );

    await settle(
      await addSource(
        deps(),
        admin,
        base.id,
        knowledgeSourceInput.parse({
          kind: 'text',
          title: 'Manual',
          content:
            '# Suporte\n\nO suporte atende de segunda a sexta, das 9h às 18h.\n\n# Entrega\n\nA entrega leva cinco dias úteis.',
        }),
        null,
      ),
    );
    await settle(
      await addSource(
        deps(),
        admin,
        base.id,
        knowledgeSourceInput.parse({
          kind: 'qa',
          title: 'FAQ',
          pairs: [{ question: 'Tem fidelidade?', answer: 'Não, o cancelamento é livre a qualquer momento.' }],
        }),
        null,
      ),
    );
    await settle(
      await addSource(
        deps(),
        admin,
        base.id,
        knowledgeSourceInput.parse({ kind: 'url', url: `http://pages.test:${port}/precos` }),
        null,
      ),
    );
    await settle(
      await addFile(
        deps(),
        admin,
        base.id,
        { name: 'politica.txt', text: 'Devolução gratuita em até 7 dias.' },
        null,
      ),
    );

    const sources = await listSources(deps(), admin, base.id);
    expect(sources.map((s) => [s.kind, s.status, s.error])).toEqual([
      ['file', 'ready', null],
      ['url', 'ready', null],
      ['qa', 'ready', null],
      ['text', 'ready', null],
    ]);
    const chunks = await sql<
      { section: string; content: string }[]
    >`select section, content from knowledge_chunks order by idx`;
    expect(
      chunks.some((c) => c.section === 'Suporte' && c.content.startsWith('Suporte\nO suporte atende')),
    ).toBe(true);
    expect(store.count(collectionName(base.id))).toBe(chunks.length);

    const hits = await testSearch(deps(), admin, base.id, 'quanto custa o plano Pro por mês');
    expect(hits[0].base).toBe('Produtos');
    expect(hits[0].content).toContain('R$ 99');
    const delivery = await testSearch(deps(), admin, base.id, 'em quantos dias chega a entrega');
    expect(delivery[0].content).toContain('cinco dias úteis');
    expect((await listBases(db(), admin))[0]).toMatchObject({ sources: 4 });
  });

  it('skips unchanged text, keeps disabled sources out and removes deleted ones', async () => {
    const { admin, embedding } = await org('acme');
    const base = await createBase(
      deps(),
      admin,
      knowledgeBaseInput.parse({ name: 'B', embeddingIntegrationId: embedding.id }),
      null,
    );
    const added = await addSource(
      deps(),
      admin,
      base.id,
      knowledgeSourceInput.parse({ kind: 'text', title: 'Horário', content: 'Abrimos às oito da manhã.' }),
      null,
    );
    await added.done;
    const after = embedCalls;
    await sql`update knowledge_sources set status = 'queued' where id = ${added.id}`;
    await listSources(deps(), admin, base.id); // resumes queued work
    await new Promise((r) => setTimeout(r, 50));
    expect(embedCalls).toBe(after); // same hash: nothing embedded again
    await reprocessSource(deps(), admin, base.id, added.id);
    expect(embedCalls).toBeGreaterThan(after); // explicit reprocess embeds again

    await setSourceEnabled(deps(), admin, base.id, added.id, false);
    expect(await testSearch(deps(), admin, base.id, 'que horas abre')).toEqual([]);
    await setSourceEnabled(deps(), admin, base.id, added.id, true);
    expect(await testSearch(deps(), admin, base.id, 'que horas abre')).toHaveLength(1);
    await deleteSource(deps(), admin, base.id, added.id, null);
    expect(store.count(collectionName(base.id))).toBe(0);

    const broken = await addSource(
      deps(),
      admin,
      base.id,
      knowledgeSourceInput.parse({ kind: 'url', url: `http://pages.test:${port}/nada` }),
      null,
    );
    await broken.done;
    expect((await listSources(deps(), admin, base.id))[0]).toMatchObject({
      status: 'failed',
      error: 'A página respondeu HTTP 404',
    });

    await deleteBase(deps(), admin, base.id, null);
    expect(store.collections.size).toBe(0);
    expect(await listBases(db(), admin)).toEqual([]);
  });

  it('is for admins only, and stays inside its organization', async () => {
    const { tenant, admin, embedding } = await org('acme');
    const [member] = await sql<SessionUser[]>`
      insert into users (tenant_id, email, name, password_hash, role)
      values (${tenant.id}, 'bia@acme.test', 'Bia', ${await hashPassword(PASSWORD)}, 'member')
      returning id, tenant_id as "tenantId", email, name, role, is_superadmin as "isSuperadmin"`;
    await expectAppError(listBases(db(), member), 403);
    const base = await createBase(
      deps(),
      admin,
      knowledgeBaseInput.parse({ name: 'B', embeddingIntegrationId: embedding.id }),
      null,
    );
    await (
      await addSource(
        deps(),
        admin,
        base.id,
        knowledgeSourceInput.parse({ kind: 'text', title: 'T', content: 'Segredo da Acme.' }),
        null,
      )
    ).done;

    const rival = await org('rival');
    await expectAppError(testSearch(deps(), rival.admin, base.id, 'segredo'), 404);
    await expectAppError(listSources(deps(), rival.admin, base.id), 404);
    const [kaiser] = await listAgents(db(), rival.admin);
    const choices = await agentChoices(db(), rival.admin);
    await expectAppError(
      updateAgent(
        db(),
        rival.admin,
        kaiser.id,
        agentInput.parse({ name: 'K', instructions: 'x', ...choices, knowledgeBaseIds: [base.id] }),
        null,
      ),
      400,
      /Base de conhecimento/,
    );
    await expectAppError(
      createBase(
        { ...deps(), store: null },
        admin,
        knowledgeBaseInput.parse({ name: 'C', embeddingIntegrationId: embedding.id }),
        null,
      ),
      501,
    );
  });

  it('lets an agent look things up in its own bases during a meeting, and trains it with examples', async () => {
    const { tenant, admin, embedding } = await org('acme');
    const base = await createBase(
      deps(),
      admin,
      knowledgeBaseInput.parse({ name: 'Vendas', embeddingIntegrationId: embedding.id }),
      null,
    );
    await (
      await addSource(
        deps(),
        admin,
        base.id,
        knowledgeSourceInput.parse({ kind: 'text', title: 'Preço', content: 'O plano Pro custa 99 reais.' }),
        null,
      )
    ).done;
    const [kaiser] = await listAgents(db(), admin);
    const choices = await agentChoices(db(), admin);
    const room = await createRoom(
      db(),
      admin,
      createRoomInput.parse({ name: 'Aula', agentIds: [kaiser.id] }),
      null,
    );
    const lkRoom = `${tenant.id}.${room.slug}`;
    expect(await agentSearch(deps(), kaiser.id, lkRoom, 'preço do plano')).toEqual([]); // not linked yet

    const saved = await updateAgent(
      db(),
      admin,
      kaiser.id,
      agentInput.parse({
        name: 'Kaiser',
        instructions: 'x',
        ...choices,
        knowledgeBaseIds: [base.id],
        styleRules: 'Seja breve.',
      }),
      null,
    );
    expect(saved.knowledgeBaseIds).toEqual([base.id]);
    const [hit] = await agentSearch(deps(), kaiser.id, lkRoom, 'preço do plano Pro');
    expect(hit).toMatchObject({ base: 'Vendas', title: 'Preço', content: 'O plano Pro custa 99 reais.' });
    await expectAppError(agentSearch(deps(), kaiser.id, `${tenant.id}.outra`, 'x'), 404);

    const example = await createExample(
      db(),
      admin,
      kaiser.id,
      agentExampleInput.parse({ question: 'Tem desconto?', answer: 'Sim, 10% no plano anual.' }),
      null,
    );
    await createExample(
      db(),
      admin,
      kaiser.id,
      agentExampleInput.parse({ question: 'Oculto', answer: 'Não use', enabled: false }),
      null,
    );
    const worker = await agentForWorker(db(), READY_AGENT_KEY, kaiser.id);
    expect(worker).toMatchObject({
      styleRules: 'Seja breve.',
      knowledgeBases: 1,
      examples: [{ question: 'Tem desconto?', answer: 'Sim, 10% no plano anual.' }],
    });
    await updateExample(
      db(),
      admin,
      kaiser.id,
      example.id,
      agentExampleInput.parse({ question: 'Tem desconto?', answer: 'Não.' }),
    );
    expect((await listExamples(db(), admin, kaiser.id)).map((e) => e.answer)).toEqual(['Não.', 'Não use']);
    await deleteExample(db(), admin, kaiser.id, example.id, null);
    expect(await listExamples(db(), admin, kaiser.id)).toHaveLength(1);
  });
});

/** The real thing: the request format Qdrant 1.20 accepts (named dense + sparse, RRF query). */
describe.skipIf(!process.env.QDRANT_TEST_URL)('Qdrant contract', () => {
  it('creates, upserts, filters by organization and searches with hybrid RRF', async () => {
    const real = qdrantStore(process.env.QDRANT_TEST_URL!, process.env.QDRANT_TEST_KEY ?? '');
    const name = collectionName(crypto.randomUUID());
    await real.ensureCollection(name, DIMS);
    await real.ensureCollection(name, DIMS); // idempotent
    await expect(real.ensureCollection(name, DIMS + 1)).rejects.toThrow(/tamanho/);
    const point = (id: string, tenant: string, source: string, text: string): VectorPoint => ({
      id,
      dense: vectorOf(text),
      sparse: { indices: [1, 7, 42], values: [1, 1.5, 2] },
      payload: {
        tenant_id: tenant,
        kb_id: 'kb',
        source_id: source,
        title: 'T',
        section: '',
        idx: 0,
        enabled: true,
        content: text,
      },
    });
    await real.upsert(name, [
      point(crypto.randomUUID(), 't1', 's1', 'plano pro custa noventa e nove reais'),
      point(crypto.randomUUID(), 't1', 's2', 'entrega leva cinco dias'),
      point(crypto.randomUUID(), 't2', 's3', 'plano pro de outra empresa'),
    ]);
    const hits = await real.search(
      name,
      't1',
      vectorOf('quanto custa o plano pro'),
      { indices: [7], values: [1] },
      5,
    );
    expect(hits.length).toBe(2);
    expect(hits.every((h) => h.payload.tenant_id === 't1')).toBe(true);
    expect(hits[0].payload.content).toContain('custa');
    await real.setSourceEnabled(name, 's1', false);
    expect(
      (await real.search(name, 't1', vectorOf('plano pro'), { indices: [], values: [] }, 5)).map(
        (h) => h.payload.source_id,
      ),
    ).toEqual(['s2']);
    await real.deleteSource(name, 's2');
    expect(await real.search(name, 't1', vectorOf('entrega'), { indices: [], values: [] }, 5)).toEqual([]);
    await real.dropCollection(name);
    await real.dropCollection(name); // already gone: fine
  });
});
