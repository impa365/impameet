import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createExample, deleteExample, listExamples, updateExample } from '@/server/agents/examples';
import { agentForWorker, listAgents, updateAgent } from '@/server/agents/service';
import { signup } from '@/server/auth/service';
import type { SessionUser } from '@/server/auth/session';
import type { Sql } from '@/server/db';
import { AppError } from '@/server/errors';
import type { Complete } from '@/server/insights/llm';
import { createIntegration } from '@/server/integrations/service';
import { type Embed, webGet } from '@/server/knowledge/ingest';
import {
  type SparseVector,
  type VectorHit,
  type VectorPoint,
  type VectorStore,
  collectionName,
  qdrantStore,
} from '@/server/knowledge/qdrant';
import type { Rerank } from '@/server/knowledge/rerank';
import {
  type KnowledgeDeps,
  type QaPair,
  addFile,
  addSource,
  addWebsite,
  agentSearch,
  chatTest,
  createBase,
  deleteBase,
  deleteSource,
  knowledgeMetrics,
  knowledgeTick,
  listBases,
  listChunks,
  listSources,
  previewWebsite,
  processSource,
  sourceDetail,
  sourceText,
  testSearch,
  updateBase,
  updateChunk,
  updateSource,
} from '@/server/knowledge/service';
import { keywords, sparseVector } from '@/server/knowledge/text';
import { createRoom } from '@/server/rooms/service';
import { hashPassword } from '@/server/security/password';
import {
  agentExampleInput,
  agentInput,
  createRoomInput,
  integrationInput,
  knowledgeBaseInput,
  knowledgeCrawlInput,
  knowledgeSourceInput,
  knowledgeWebsiteInput,
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

const visible = (p: VectorPoint, tenantId: string) =>
  p.payload.tenant_id === tenantId && p.payload.enabled && p.payload.chunk_enabled !== false;

/** Qdrant stand-in: filters like the real one (tenant, source and piece on/off). */
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
      expect(p.sparse.indices.length).toBeGreaterThan(0);
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
  async setChunkEnabled(name: string, pointId: string, enabled: boolean) {
    const p = this.collections.get(name)?.points.get(pointId);
    if (p) p.payload.chunk_enabled = enabled;
  }
  private rank(
    name: string,
    tenantId: string,
    score: (p: VectorPoint) => number,
    limit: number,
    min: number,
  ) {
    return [...(this.collections.get(name)?.points.values() ?? [])]
      .filter((p) => visible(p, tenantId))
      .map((p): VectorHit => ({ id: p.id, score: score(p), payload: p.payload }))
      .filter((h) => h.score > min)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
  async searchDense(name: string, tenantId: string, dense: number[], limit: number, minScore: number) {
    return this.rank(
      name,
      tenantId,
      (p) => p.dense.reduce((s, x, i) => s + x * dense[i], 0),
      limit,
      minScore,
    );
  }
  async searchSparse(name: string, tenantId: string, sparse: SparseVector, limit: number) {
    const words = new Map(sparse.indices.map((i, k) => [i, sparse.values[k]]));
    const dot = (p: VectorPoint) =>
      p.sparse.indices.reduce((s, i, k) => s + (words.get(i) ?? 0) * p.sparse.values[k], 0);
    return this.rank(name, tenantId, dot, limit, 0);
  }
  count(name: string) {
    return this.collections.get(name)?.points.size ?? 0;
  }
}

const page = (title: string, body: string) =>
  `<html><head><title>${title}</title></head><body><main>${body}</main></body></html>`;
let port = 0;
const site = () => `http://pages.test:${port}`;
const pages: Record<string, () => string> = {
  '/precos': () =>
    page('Preços', '<h1>Planos</h1><p>O plano Pro custa R$ 99 por mês.</p><a href="/sobre">Sobre</a>'),
  '/': () =>
    page('Início', '<a href="/sobre">Sobre</a> <a href="/contato">Contato</a> <a href="/admin">x</a>'),
  '/sobre': () => page('Sobre nós', '<p>A Acme fabrica foguetes desde 1950 em Natal.</p>'),
  '/contato': () => page('Contato', '<p>Fale com a Acme pelo telefone 0800 123 456.</p>'),
  '/admin': () => page('Painel', '<p>Área restrita.</p>'),
  '/robots.txt': () => `User-agent: *\nDisallow: /admin\nSitemap: ${site()}/sitemap.xml\n`,
  '/sitemap.xml': () =>
    `<urlset><url><loc>${site()}/sobre</loc></url><url><loc>${site()}/contato</loc></url></urlset>`,
};
const server = http.createServer((req, res) => {
  const body = pages[req.url ?? ''];
  if (!body) {
    res.writeHead(404);
    return res.end();
  }
  const type = req.url?.endsWith('.txt')
    ? 'text/plain'
    : req.url?.endsWith('.xml')
      ? 'application/xml'
      : 'text/html';
  res.writeHead(200, { 'content-type': `${type}; charset=utf-8` });
  res.end(body());
});

let store: MemoryStore;
let pending: Promise<void>[] = [];
let completions: Parameters<Complete>[0][] = [];
const reranker = (): Rerank => async (query, docs) =>
  docs.map((d) => (d.toLowerCase().includes(query.toLowerCase().split(' ').at(-1) ?? '') ? 1 : 0.1));
const net: KnowledgeDeps['net'] = {
  privateHosts: new Set(['pages.test']),
  resolve: async () => ['127.0.0.1'],
};
const deps = (): KnowledgeDeps => {
  const d: KnowledgeDeps = {
    sql: db(),
    key: READY_AGENT_KEY,
    net,
    store,
    embedder,
    reranker,
    complete: async (req) => {
      completions.push(req);
      return 'O plano Pro custa R$ 99 [1].';
    },
    get: webGet(net),
    schedule: (id) => {
      pending.push(processSource(d, id));
    },
  };
  return d;
};

/** Waits for every queued indexing run, including the ones they queue in turn. */
async function drain() {
  while (pending.length > 0) await Promise.all(pending.splice(0));
}

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
  pending = [];
  completions = [];
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

const integrationDeps = () => ({ sql: db(), key: READY_AGENT_KEY, resolve: async () => ['93.184.215.14'] });

async function org(slug: string) {
  const { tenant, user: admin } = await signup(
    db(),
    { organization: `Org ${slug}`, slug, name: 'Admin', email: `admin@${slug}.test`, password: PASSWORD },
    null,
    'enterprise',
  );
  const embedding = await createIntegration(
    integrationDeps(),
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

async function newBase(admin: SessionUser, embeddingId: string, name = 'B') {
  return createBase(
    deps(),
    admin,
    knowledgeBaseInput.parse({ name, embeddingIntegrationId: embeddingId }),
    null,
  );
}

async function addText(admin: SessionUser, kbId: string, title: string, content: string) {
  const { ids } = await addSource(
    deps(),
    admin,
    kbId,
    knowledgeSourceInput.parse({ kind: 'text', title, content }),
    null,
  );
  await drain();
  return ids[0];
}

const search = async (admin: SessionUser, kbId: string, query: string) =>
  (await testSearch(deps(), admin, kbId, query)).hits;

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
    const base = await newBase(admin, embedding.id, 'Produtos');
    expect(base).toMatchObject({
      name: 'Produtos',
      embeddingModel: 'text-embedding-3-small',
      dimensions: DIMS,
      sources: 0,
      chunkSize: 1200,
      chunkOverlap: 150,
      retrievalMode: 'hybrid',
      topK: 5,
    });
    expect(store.collections.has(collectionName(base.id))).toBe(true);
    await expectAppError(newBase(admin, embedding.id, 'Produtos'), 409);

    await addText(
      admin,
      base.id,
      'Manual',
      '# Suporte\n\nO suporte atende de segunda a sexta, das 9h às 18h.\n\n# Entrega\n\nA entrega leva cinco dias úteis.',
    );
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
    );
    await addSource(
      deps(),
      admin,
      base.id,
      knowledgeSourceInput.parse({ kind: 'url', url: `${site()}/precos` }),
      null,
    );
    await addFile(
      deps(),
      admin,
      base.id,
      { name: 'politica.txt', text: 'Devolução gratuita em até 7 dias.' },
      null,
    );
    await drain();

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

    const { hits, trace } = await testSearch(deps(), admin, base.id, 'quanto custa o plano Pro por mês');
    expect(hits[0]).toMatchObject({ base: 'Produtos', url: `${site()}/precos` });
    expect(hits[0].content).toContain('R$ 99');
    expect(trace[0]).toMatchObject({ base: 'Produtos', mode: 'hybrid', reranked: false });
    expect(trace[0].dense).toBeGreaterThan(0);
    expect(trace[0].sparse).toBeGreaterThan(0);
    const delivery = await search(admin, base.id, 'em quantos dias chega a entrega');
    expect(delivery[0].content).toContain('cinco dias úteis');
    expect((await listBases(db(), admin))[0]).toMatchObject({ sources: 4 });
    const [url] = sources.filter((s) => s.kind === 'url');
    expect((await sourceText(deps(), admin, base.id, url.id)).text).toContain('R$ 99');
    expect((await sourceDetail(deps(), admin, base.id, url.id)).jobs).toMatchObject([
      { reason: 'added', status: 'done' },
    ]);
  });

  it('skips unchanged text, keeps disabled sources out and removes deleted ones', async () => {
    const { admin, embedding } = await org('acme');
    const base = await newBase(admin, embedding.id);
    const id = await addText(admin, base.id, 'Horário', 'Abrimos às oito da manhã.');
    const after = embedCalls;
    await sql`update knowledge_sources set status = 'queued' where id = ${id}`;
    expect(await knowledgeTick(deps())).toBe(1); // resumes queued work
    await drain();
    expect(embedCalls).toBe(after); // same hash: nothing embedded again
    await updateSource(deps(), admin, base.id, id, { reprocess: true });
    await drain();
    expect(embedCalls).toBeGreaterThan(after); // explicit reprocess embeds again
    expect((await sourceDetail(deps(), admin, base.id, id)).jobs.map((j) => j.reason)).toEqual([
      'reindex',
      'added',
      'added',
    ]);

    await updateSource(deps(), admin, base.id, id, { enabled: false });
    expect(await search(admin, base.id, 'que horas abre')).toEqual([]);
    await updateSource(deps(), admin, base.id, id, { enabled: true });
    expect(await search(admin, base.id, 'que horas abre')).toHaveLength(1);

    await updateSource(deps(), admin, base.id, id, { content: 'Abrimos às dez da manhã.' });
    await drain();
    expect((await search(admin, base.id, 'que horas abre'))[0].content).toBe('Abrimos às dez da manhã.');
    await expectAppError(updateSource(deps(), admin, base.id, id, { syncInterval: 'daily' }), 400);

    await deleteSource(deps(), admin, base.id, id, null);
    expect(store.count(collectionName(base.id))).toBe(0);

    await addSource(
      deps(),
      admin,
      base.id,
      knowledgeSourceInput.parse({ kind: 'url', url: `${site()}/nada` }),
      null,
    );
    await drain();
    expect((await listSources(deps(), admin, base.id))[0]).toMatchObject({
      status: 'failed',
      error: 'A página respondeu HTTP 404',
    });

    await deleteBase(deps(), admin, base.id, null);
    expect(store.collections.size).toBe(0);
    expect(await listBases(db(), admin)).toEqual([]);
  });

  it('edits Q&A pairs and single pieces, and deleted or switched-off answers are never found', async () => {
    const { admin, embedding } = await org('acme');
    const base = await newBase(admin, embedding.id);
    const {
      ids: [qa],
    } = await addSource(
      deps(),
      admin,
      base.id,
      knowledgeSourceInput.parse({
        kind: 'qa',
        title: 'FAQ',
        pairs: [
          { question: 'Tem fidelidade?', answer: 'Não, o cancelamento é livre.' },
          { question: 'Aceita pix?', answer: 'Sim, pix e boleto bancário.' },
        ],
      }),
      null,
    );
    await drain();
    expect((await search(admin, base.id, 'aceita pix boleto'))[0].content).toContain('boleto');
    const pairs = (await sourceDetail(deps(), admin, base.id, qa)).settings.pairs as QaPair[];
    expect(pairs).toHaveLength(2);

    // Removing a pair (or switching it off) takes it out of the search for good.
    await updateSource(deps(), admin, base.id, qa, {
      pairs: [{ ...pairs[0] }, { ...pairs[1], active: false }],
    });
    await drain();
    expect(
      (await search(admin, base.id, 'aceita pix boleto')).some((h) => h.content.includes('boleto')),
    ).toBe(false);
    await expectAppError(
      updateSource(deps(), admin, base.id, qa, { pairs: [{ ...pairs[0], active: false }] }),
      400,
      /ativa/,
    );

    const textId = await addText(admin, base.id, 'Endereço', 'Ficamos na Rua das Flores, 12, em Natal.');
    const { total, chunks } = await listChunks(deps(), admin, base.id, textId, 0);
    expect(total).toBe(1);
    await updateChunk(deps(), admin, base.id, chunks[0].id, { enabled: false });
    expect(
      (await search(admin, base.id, 'rua das flores natal')).some((h) => h.content.includes('Flores')),
    ).toBe(false);
    const edited = await updateChunk(deps(), admin, base.id, chunks[0].id, {
      enabled: true,
      content: 'Ficamos na Avenida Brasil, 500, em Natal.',
    });
    expect(edited).toMatchObject({ enabled: true, edited: true });
    expect((await search(admin, base.id, 'avenida brasil natal'))[0].content).toContain('Avenida Brasil');

    const rival = await org('rival');
    await expectAppError(updateChunk(deps(), rival.admin, base.id, chunks[0].id, { enabled: false }), 404);
    await expectAppError(listChunks(deps(), rival.admin, base.id, textId, 0), 404);
  });

  it('re-cuts every source when the cut changes, and follows the chosen way of searching', async () => {
    const { admin, embedding } = await org('acme');
    const base = await newBase(admin, embedding.id);
    const long = Array.from(
      { length: 12 },
      (_, i) => `Parágrafo ${i + 1} sobre o produto número ${i + 1}.`,
    ).join('\n\n');
    const id = await addText(admin, base.id, 'Longo', long);
    const before = (await listChunks(deps(), admin, base.id, id, 0)).total;

    const changed = await updateBase(deps(), admin, base.id, { chunkSize: 200, chunkOverlap: 0 }, null);
    expect(changed).toMatchObject({ chunkSize: 200, chunkOverlap: 0 });
    await drain();
    expect((await listChunks(deps(), admin, base.id, id, 0)).total).toBeGreaterThan(before);
    expect((await sourceDetail(deps(), admin, base.id, id)).jobs[0]).toMatchObject({ reason: 'settings' });

    await updateBase(deps(), admin, base.id, { retrievalMode: 'keyword', topK: 2 }, null);
    const calls = embedCalls;
    const keyword = await testSearch(deps(), admin, base.id, 'produto número 7');
    expect(embedCalls).toBe(calls); // keywords only: no embedding of the question
    expect(keyword.trace[0]).toMatchObject({ mode: 'keyword', dense: 0 });
    expect(keyword.hits.length).toBeLessThanOrEqual(2);

    const rerank = await createIntegration(
      integrationDeps(),
      admin,
      integrationInput.parse({
        kind: 'rerank',
        name: 'Cohere',
        baseUrl: 'https://api.cohere.com/v2',
        apiKey: 'co-0123456789abcdef',
        defaultModel: 'rerank-v3.5',
      }),
      null,
    );
    await updateBase(
      deps(),
      admin,
      base.id,
      { retrievalMode: 'hybrid', rerankIntegrationId: rerank.id },
      null,
    );
    const reranked = await testSearch(deps(), admin, base.id, 'parágrafo 9');
    expect(reranked.trace[0].reranked).toBe(true);
    expect(reranked.hits[0].score).toBe(1);
    await expectAppError(
      updateBase(deps(), admin, base.id, { rerankIntegrationId: embedding.id }, null),
      400,
    );
  });

  it('answers in the test chat with the chosen model, citing the pieces it was given', async () => {
    const { admin, embedding } = await org('acme');
    const base = await newBase(admin, embedding.id);
    await addText(admin, base.id, 'Preço', 'O plano Pro custa R$ 99 por mês.');
    const choices = await agentChoices(db(), admin);
    const res = await chatTest(deps(), admin, base.id, {
      question: 'Quanto custa o plano Pro?',
      integrationId: choices.llmIntegrationId,
      model: 'gpt-test',
    });
    expect(res.answer).toContain('[1]');
    expect(res.hits[0].content).toContain('R$ 99');
    expect(completions[0].model).toBe('gpt-test');
    expect(completions[0].messages[0].content).toContain('[1] Preço');
    await expectAppError(
      chatTest(deps(), admin, base.id, { question: 'x', integrationId: embedding.id, model: 'm' }),
      400,
      /LLM/,
    );
  });

  it('imports a website: finds its pages (robots, sitemap, links) and indexes the chosen ones', async () => {
    const { admin, embedding } = await org('acme');
    const base = await newBase(admin, embedding.id);
    const found = await previewWebsite(
      deps(),
      admin,
      base.id,
      knowledgeCrawlInput.parse({ url: `${site()}/` }),
    );
    const urls = found.map((p) => p.url);
    expect(urls).toEqual(expect.arrayContaining([`${site()}/sobre`, `${site()}/contato`]));
    expect(urls).not.toContain(`${site()}/admin`); // robots.txt

    await expectAppError(
      addWebsite(
        deps(),
        admin,
        base.id,
        knowledgeWebsiteInput.parse({ url: `${site()}/`, pages: ['https://outro.example/x'] }),
        null,
      ),
      400,
      /mesmo site/,
    );
    const { id } = await addWebsite(
      deps(),
      admin,
      base.id,
      knowledgeWebsiteInput.parse({ url: `${site()}/`, pages: [`${site()}/sobre`, `${site()}/contato`] }),
      null,
    );
    await drain();
    const detail = await sourceDetail(deps(), admin, base.id, id);
    expect(detail).toMatchObject({ kind: 'website', status: 'ready', progress: 100 });
    expect(detail.children.map((c) => [c.title, c.status])).toEqual([
      ['Contato', 'ready'],
      ['Sobre nós', 'ready'],
    ]);
    expect(detail.log.filter((l) => l.ok)).toHaveLength(2);
    expect((await listSources(deps(), admin, base.id)).map((s) => s.kind)).toEqual(['website']);
    const [hit] = await search(admin, base.id, 'quando a acme fabrica foguetes');
    expect(hit).toMatchObject({ title: 'Sobre nós', url: `${site()}/sobre` });

    await updateSource(deps(), admin, base.id, id, { enabled: false });
    expect(await search(admin, base.id, 'foguetes')).toEqual([]);
    await updateSource(deps(), admin, base.id, id, { enabled: true, syncInterval: 'weekly' });
    const contato = detail.children.find((c) => c.title === 'Contato')!;
    await deleteSource(deps(), admin, base.id, contato.id, null);
    expect((await sourceDetail(deps(), admin, base.id, id)).children).toHaveLength(1);
    await deleteSource(deps(), admin, base.id, id, null);
    expect(store.count(collectionName(base.id))).toBe(0);
  });

  it('is for admins only, and stays inside its organization', async () => {
    const { tenant, admin, embedding } = await org('acme');
    const [member] = await sql<SessionUser[]>`
      insert into users (tenant_id, email, name, password_hash, role)
      values (${tenant.id}, 'bia@acme.test', 'Bia', ${await hashPassword(PASSWORD)}, 'member')
      returning id, tenant_id as "tenantId", email, name, role, is_superadmin as "isSuperadmin"`;
    await expectAppError(listBases(db(), member), 403);
    const base = await newBase(admin, embedding.id);
    await addText(admin, base.id, 'T', 'Segredo da Acme.');

    const rival = await org('rival');
    await expectAppError(testSearch(deps(), rival.admin, base.id, 'segredo'), 404);
    await expectAppError(listSources(deps(), rival.admin, base.id), 404);
    await expectAppError(knowledgeMetrics(db(), rival.admin, base.id), 404);
    await expectAppError(updateBase(deps(), rival.admin, base.id, { name: 'Minha' }, null), 404);
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
    const base = await newBase(admin, embedding.id, 'Vendas');
    await addText(admin, base.id, 'Preço', 'O plano Pro custa 99 reais.');
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
    const [hit] = await agentSearch(deps(), kaiser.id, lkRoom, 'preço do plano Pro', 'pt-BR');
    expect(hit).toMatchObject({ base: 'Vendas', title: 'Preço', content: 'O plano Pro custa 99 reais.' });
    await agentSearch(deps(), kaiser.id, lkRoom, 'xyzzy', 'pt-BR');
    await expectAppError(agentSearch(deps(), kaiser.id, `${tenant.id}.outra`, 'x'), 404);

    const metrics = await knowledgeMetrics(db(), admin, base.id, 7);
    expect(metrics).toMatchObject({ searches: 2, byOrigin: [{ origin: 'agent', count: 2 }] });
    expect(metrics.topChunks[0]).toMatchObject({ title: 'Preço' });
    expect(metrics.topChunks[0].hits).toBeGreaterThanOrEqual(1);
    expect(metrics.daily).toHaveLength(1);

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

/** The real thing: the request format Qdrant 1.20 accepts (named dense + sparse vectors). */
describe.skipIf(!process.env.QDRANT_TEST_URL)('Qdrant contract', () => {
  it('creates, upserts, filters by organization and searches by meaning and by keywords', async () => {
    const real = qdrantStore(process.env.QDRANT_TEST_URL!, process.env.QDRANT_TEST_KEY ?? '');
    const name = collectionName(crypto.randomUUID());
    await real.ensureCollection(name, DIMS);
    await real.ensureCollection(name, DIMS); // idempotent
    await expect(real.ensureCollection(name, DIMS + 1)).rejects.toThrow(/tamanho/);
    // Clearly different meaning vectors (one axis each), so the ranking is never a coin toss.
    const axis = (i: number) => Array.from({ length: DIMS }, (_, j) => (j === i ? 1 : 0));
    const point = (id: string, tenant: string, source: string, text: string, dir: number): VectorPoint => ({
      id,
      dense: axis(dir),
      sparse: sparseVector(text),
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
    const one = crypto.randomUUID();
    await real.upsert(name, [
      point(one, 't1', 's1', 'plano pro custa noventa e nove reais', 0),
      point(crypto.randomUUID(), 't1', 's2', 'entrega leva cinco dias', 1),
      point(crypto.randomUUID(), 't2', 's3', 'plano pro custa pouco em outra empresa', 0),
    ]);
    const dense = await real.searchDense(name, 't1', axis(0), 5, 0);
    expect(dense.every((h) => h.payload.tenant_id === 't1')).toBe(true);
    expect(dense[0].payload.source_id).toBe('s1');
    expect(await real.searchDense(name, 't1', axis(0), 5, 0.5)).toHaveLength(1); // threshold
    const words = await real.searchSparse(name, 't1', sparseVector('entrega cinco dias'), 5);
    expect(words[0].payload.source_id).toBe('s2');
    expect(words.every((h) => h.payload.tenant_id === 't1')).toBe(true);

    await real.setChunkEnabled(name, one, false);
    expect((await real.searchDense(name, 't1', axis(0), 5, 0)).map((h) => h.payload.source_id)).toEqual([
      's2',
    ]);
    await real.setChunkEnabled(name, one, true);
    await real.setSourceEnabled(name, 's1', false);
    expect((await real.searchSparse(name, 't1', sparseVector('plano'), 5)).length).toBe(0);
    await real.deleteSource(name, 's2');
    expect(await real.searchDense(name, 't1', axis(1), 5, 0)).toEqual([]);
    await real.dropCollection(name);
    await real.dropCollection(name); // already gone: fine
  });
});
