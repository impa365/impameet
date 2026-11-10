/**
 * Rerankers re-read the candidate pieces against the question and score them again, which
 * puts the best answer first far more reliably than vector similarity alone. Cohere, Jina and
 * Voyage share the same /rerank request; their answers differ only in the list's name.
 */

export interface RerankConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export type Rerank = (query: string, documents: string[]) => Promise<number[]>;

const MAX_DOC_CHARS = 4000;

export function httpReranker(config: RerankConfig, fetchImpl: typeof fetch = fetch): Rerank {
  return async (query, documents) => {
    if (documents.length === 0) return [];
    const res = await fetchImpl(`${config.baseUrl.replace(/\/+$/, '')}/rerank`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        query,
        documents: documents.map((d) => d.slice(0, MAX_DOC_CHARS)),
        top_n: documents.length,
      }),
      signal: AbortSignal.timeout(20_000),
      redirect: 'error',
    });
    if (!res.ok) throw new Error(`O reranqueador respondeu ${res.status}`);
    const body = (await res.json().catch(() => null)) as {
      results?: { index?: number; relevance_score?: number }[];
      data?: { index?: number; relevance_score?: number }[];
    } | null;
    const rows = body?.results ?? body?.data ?? [];
    const scores = documents.map(() => 0);
    for (const r of rows)
      if (typeof r.index === 'number' && r.index >= 0 && r.index < scores.length)
        scores[r.index] = Number(r.relevance_score ?? 0);
    return scores;
  };
}
