/**
 * Qdrant over its REST API: one collection per knowledge base, with a named meaning vector
 * ("dense") and a keyword vector ("text", IDF applied by Qdrant) for hybrid search fused with
 * RRF on the server. Every point carries its organization, so searches always filter on it.
 */

export interface VectorPoint {
  id: string;
  dense: number[];
  sparse: { indices: number[]; values: number[] };
  payload: {
    tenant_id: string;
    kb_id: string;
    source_id: string;
    title: string;
    section: string;
    idx: number;
    enabled: boolean;
    content: string;
  };
}

export interface VectorHit {
  id: string;
  score: number;
  payload: VectorPoint['payload'];
}

export interface VectorStore {
  ensureCollection(name: string, dimensions: number): Promise<void>;
  dropCollection(name: string): Promise<void>;
  upsert(name: string, points: VectorPoint[]): Promise<void>;
  deleteSource(name: string, sourceId: string): Promise<void>;
  setSourceEnabled(name: string, sourceId: string, enabled: boolean): Promise<void>;
  search(
    name: string,
    tenantId: string,
    dense: number[],
    sparse: { indices: number[]; values: number[] },
    limit: number,
  ): Promise<VectorHit[]>;
}

export class QdrantError extends Error {}

const BATCH = 64;
const TIMEOUT_MS = 30_000;
const CANDIDATES = 40;

export function qdrantStore(url: string, apiKey: string, fetchImpl: typeof fetch = fetch): VectorStore {
  const base = url.replace(/\/+$/, '');
  async function call(method: string, path: string, body?: unknown, ok404 = false): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: { 'api-key': apiKey, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new QdrantError('A base vetorial (Qdrant) não respondeu');
    }
    if (ok404 && res.status === 404) return null;
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new QdrantError(`Qdrant respondeu ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
    return res.json().catch(() => null);
  }
  const filterSource = (sourceId: string) => ({ must: [{ key: 'source_id', match: { value: sourceId } }] });

  return {
    async ensureCollection(name, dimensions) {
      const existing = (await call('GET', `/collections/${name}`, undefined, true)) as {
        result?: { config?: { params?: { vectors?: { dense?: { size?: number } } } } };
      } | null;
      if (existing) {
        const size = existing.result?.config?.params?.vectors?.dense?.size;
        if (size !== dimensions) throw new QdrantError(`A coleção ${name} tem vetores de tamanho ${size}`);
        return;
      }
      await call('PUT', `/collections/${name}`, {
        vectors: { dense: { size: dimensions, distance: 'Cosine' } },
        sparse_vectors: { text: { modifier: 'idf' } },
        hnsw_config: { m: 16, ef_construct: 100 },
      });
      for (const [field, schema] of [
        ['tenant_id', 'keyword'],
        ['source_id', 'keyword'],
        ['enabled', 'bool'],
      ])
        await call('PUT', `/collections/${name}/index?wait=true`, {
          field_name: field,
          field_schema: schema,
        });
    },
    async dropCollection(name) {
      await call('DELETE', `/collections/${name}`, undefined, true);
    },
    async upsert(name, points) {
      for (let i = 0; i < points.length; i += BATCH) {
        await call('PUT', `/collections/${name}/points?wait=true`, {
          points: points.slice(i, i + BATCH).map((p) => ({
            id: p.id,
            vector: { dense: p.dense, text: p.sparse },
            payload: p.payload,
          })),
        });
      }
    },
    async deleteSource(name, sourceId) {
      await call(
        'POST',
        `/collections/${name}/points/delete?wait=true`,
        { filter: filterSource(sourceId) },
        true,
      );
    },
    async setSourceEnabled(name, sourceId, enabled) {
      await call('POST', `/collections/${name}/points/payload?wait=true`, {
        payload: { enabled },
        filter: filterSource(sourceId),
      });
    },
    async search(name, tenantId, dense, sparse, limit) {
      const filter = {
        must: [
          { key: 'tenant_id', match: { value: tenantId } },
          { key: 'enabled', match: { value: true } },
        ],
      };
      const prefetch = [{ query: dense, using: 'dense', limit: CANDIDATES, filter }];
      if (sparse.indices.length > 0)
        prefetch.push({ query: sparse as never, using: 'text', limit: CANDIDATES, filter });
      const res = (await call('POST', `/collections/${name}/points/query`, {
        prefetch,
        query: { fusion: 'rrf' },
        filter,
        limit,
        with_payload: true,
      })) as { result?: { points?: { id: string; score: number; payload: VectorPoint['payload'] }[] } };
      return (res?.result?.points ?? []).map((p) => ({
        id: String(p.id),
        score: p.score,
        payload: p.payload,
      }));
    },
  };
}

/** Qdrant collection names: letters, digits and underscores only. */
export function collectionName(kbId: string): string {
  return `impameet_kb_${kbId.replace(/-/g, '')}`;
}
