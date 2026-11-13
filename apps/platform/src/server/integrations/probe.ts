/** Live checks of provider credentials (used by "Testar conexão" and "Buscar modelos"). */
import { isRerankModel, modelCategory } from '@/lib/models';

export type Fetch = typeof fetch;

export const FISH_API_URL = 'https://api.fish.audio';
export const DEEPGRAM_API_URL = 'https://api.deepgram.com';
export const ELEVENLABS_API_URL = 'https://api.elevenlabs.io';
const TIMEOUT_MS = 10_000;

export type ProbeResult =
  | {
      ok: true;
      models: string[];
      /** Embedding models: the provider's metadata, its dedicated list, or their name. */
      embeddings?: string[];
      /** Reranking models, the same way. */
      rerankers?: string[];
      /** What the tested integration proved it can do ("Testar conexão" only). */
      capabilities?: ('chat' | 'embeddings' | 'rerank')[];
    }
  | { ok: false; error: string };

function reason(status: number): string {
  if (status === 401 || status === 403) return 'A chave foi recusada pelo provedor';
  if (status === 404) return 'Endereço não encontrado: confira a URL da API';
  if (status === 429) return 'O provedor limitou as requisições (429); tente mais tarde';
  return `O provedor respondeu com erro ${status}`;
}

/** `endpoint` ("GET /models") says which call failed; the key never goes in a message. */
function failure(status: number, endpoint?: string): ProbeResult {
  return { ok: false, error: endpoint ? `${endpoint}: ${reason(status)}` : reason(status) };
}

const unreachable = (endpoint: string): ProbeResult => ({
  ok: false,
  error: `${endpoint}: Não foi possível conectar ao provedor`,
});

/** How many models a catalog may list (gateways with combos and aliases list thousands). */
export const MAX_DISCOVERED = 5000;
/** How many entries are read at all, so a hostile endpoint cannot make this loop forever. */
const MAX_ENTRIES = 20_000;
const CAPABILITY_KEYS = ['type', 'mode', 'task', 'model_type', 'category', 'capabilities', 'endpoints'];

export interface ModelCatalog {
  models: string[];
  /** Embedding models, by the provider's own metadata or by their name. */
  embeddings: string[];
  /** Reranking models, the same way. */
  rerankers: string[];
}

/** Words a catalog entry uses to say what the model does (type, mode, capabilities, endpoints…). */
function capabilityWords(entry: Record<string, unknown>): string {
  const words: string[] = [];
  const add = (v: unknown): void => {
    if (typeof v === 'string') words.push(v);
    else if (Array.isArray(v)) v.forEach(add);
    else if (v && typeof v === 'object') {
      for (const [k, on] of Object.entries(v))
        if (on === true || typeof on === 'string') words.push(k, String(on));
    }
  };
  for (const key of [...CAPABILITY_KEYS, 'supported_endpoints']) add(entry[key]);
  const architecture = entry.architecture;
  if (architecture && typeof architecture === 'object')
    add((architecture as Record<string, unknown>).output_modalities);
  return words.join(' ').toLowerCase();
}

/**
 * An OpenAI-compatible model list, its capabilities read before anything is cut: entries
 * without a usable id are skipped one by one, and embedding and reranking models (combos and
 * aliases included) are always kept even when the catalog is longer than the limit.
 */
export function readCatalog(body: unknown): ModelCatalog {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return { models: [], embeddings: [], rerankers: [] };
  const all = new Set<string>();
  const embeddings = new Set<string>();
  const rerankers = new Set<string>();
  for (const entry of data.slice(0, MAX_ENTRIES)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const raw = (entry as { id?: unknown }).id;
    if (typeof raw !== 'string' && typeof raw !== 'number') continue;
    // Gemini lists "models/gemini-…" but its endpoints take the bare name.
    const id = String(raw)
      .trim()
      .replace(/^models\//, '');
    if (id.length === 0 || id.length > 120) continue;
    all.add(id);
    const said = capabilityWords(entry as Record<string, unknown>);
    if (/rerank/.test(said) || isRerankModel(id)) rerankers.add(id);
    else if (/embed/.test(said) || modelCategory(id) === 'embedding') embeddings.add(id);
  }
  const special = [...embeddings, ...rerankers];
  const others = [...all].filter((m) => !embeddings.has(m) && !rerankers.has(m)).sort();
  const models = [...special, ...others.slice(0, Math.max(0, MAX_DISCOVERED - special.length))].sort();
  return { models, embeddings: [...embeddings].sort(), rerankers: [...rerankers].sort() };
}

async function call(
  fetchImpl: Fetch,
  url: string,
  auth: Record<string, string>,
): Promise<Response | ProbeResult> {
  try {
    return await fetchImpl(url, {
      headers: { ...auth, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
  } catch {
    return { ok: false, error: 'Não foi possível conectar ao provedor' };
  }
}

/** OpenAI-compatible: GET {baseUrl}/models lists what this key can use. */
export async function probeLlm(
  fetchImpl: Fetch,
  baseUrl: string,
  apiKey: string,
  path = '/models',
): Promise<ProbeResult> {
  const endpoint = `GET ${path}`;
  const res = await call(fetchImpl, `${baseUrl}${path}`, { authorization: `Bearer ${apiKey}` });
  if (!(res instanceof Response)) return unreachable(endpoint);
  if (!res.ok) return failure(res.status, endpoint);
  const catalog = readCatalog(await res.json().catch(() => null));
  return {
    ok: true,
    models: catalog.models,
    ...(catalog.embeddings.length ? { embeddings: catalog.embeddings } : {}),
    ...(catalog.rerankers.length ? { rerankers: catalog.rerankers } : {}),
  };
}

/** Fish Audio: the account's API credit only answers to a valid key. */
export async function probeFish(fetchImpl: Fetch, apiKey: string): Promise<ProbeResult> {
  const res = await call(fetchImpl, `${FISH_API_URL}/wallet/self/api-credit`, {
    authorization: `Bearer ${apiKey}`,
  });
  return verdict(res);
}

/** Deepgram: the key's projects only answer to a valid key ("Token" scheme). */
export async function probeDeepgram(fetchImpl: Fetch, apiKey: string): Promise<ProbeResult> {
  return verdict(
    await call(fetchImpl, `${DEEPGRAM_API_URL}/v1/projects`, { authorization: `Token ${apiKey}` }),
  );
}

/** ElevenLabs: the model list only answers to a valid key (xi-api-key header). */
export async function probeElevenLabs(fetchImpl: Fetch, apiKey: string): Promise<ProbeResult> {
  return verdict(await call(fetchImpl, `${ELEVENLABS_API_URL}/v1/models`, { 'xi-api-key': apiKey }));
}

function verdict(res: Response | ProbeResult): ProbeResult {
  if (!(res instanceof Response)) return res;
  return res.ok ? { ok: true, models: [] } : failure(res.status);
}

/** Cohere / Jina / Voyage style: ranking two tiny documents proves the key and the model. */
export async function probeRerank(
  fetchImpl: Fetch,
  baseUrl: string,
  apiKey: string,
  model: string,
): Promise<ProbeResult> {
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/rerank`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ model, query: 'teste', documents: ['teste', 'outro'], top_n: 2 }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
  } catch {
    return unreachable('POST /rerank');
  }
  if (!res.ok) return failure(res.status, 'POST /rerank');
  const body = (await res.json().catch(() => null)) as { results?: unknown[]; data?: unknown[] } | null;
  if (!Array.isArray(body?.results) && !Array.isArray(body?.data))
    return { ok: false, error: 'O provedor não devolveu uma classificação' };
  return { ok: true, models: [model] };
}

/** OpenAI-compatible: one tiny embedding proves the key and the model, and tells the size. */
export async function probeEmbedding(
  fetchImpl: Fetch,
  baseUrl: string,
  apiKey: string,
  model: string,
): Promise<ProbeResult> {
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ model, input: ['teste'] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
  } catch {
    return unreachable('POST /embeddings');
  }
  if (!res.ok) return failure(res.status, 'POST /embeddings');
  const body = (await res.json().catch(() => null)) as { data?: { embedding?: unknown }[] } | null;
  const vector = body?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length === 0)
    return { ok: false, error: 'O provedor não devolveu um embedding' };
  return { ok: true, models: [`${model} (${vector.length})`] };
}
