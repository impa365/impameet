/** Live checks of provider credentials (used by "Testar conexão" and "Buscar modelos"). */

export type Fetch = typeof fetch;

export const FISH_API_URL = 'https://api.fish.audio';
export const DEEPGRAM_API_URL = 'https://api.deepgram.com';
export const ELEVENLABS_API_URL = 'https://api.elevenlabs.io';
const TIMEOUT_MS = 10_000;

export type ProbeResult =
  | {
      ok: true;
      models: string[];
      /** Models the provider lists as embedding models (routers such as 9router list them apart). */
      embeddings?: string[];
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

/** The ids an OpenAI-compatible list gives; entries without a usable id are left out. */
export function modelIds(body: unknown): string[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const ids = data
    .map((m) => (typeof m === 'object' && m !== null ? (m as { id?: unknown }).id : undefined))
    .filter((id): id is string | number => typeof id === 'string' || typeof id === 'number')
    // Gemini lists "models/gemini-…" but its chat endpoint takes the bare name.
    .map((id) =>
      String(id)
        .trim()
        .replace(/^models\//, ''),
    )
    .filter((id) => id.length > 0 && id.length <= 120);
  return [...new Set(ids)].sort().slice(0, 500);
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
  return { ok: true, models: modelIds(await res.json().catch(() => null)) };
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
