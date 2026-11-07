/** Live checks of provider credentials (used by "Testar conexão" and "Buscar modelos"). */

export type Fetch = typeof fetch;

export const FISH_API_URL = 'https://api.fish.audio';
export const DEEPGRAM_API_URL = 'https://api.deepgram.com';
export const ELEVENLABS_API_URL = 'https://api.elevenlabs.io';
const TIMEOUT_MS = 10_000;

export type ProbeResult = { ok: true; models: string[] } | { ok: false; error: string };

function failure(status: number): ProbeResult {
  if (status === 401 || status === 403) return { ok: false, error: 'A chave foi recusada pelo provedor' };
  if (status === 404) return { ok: false, error: 'Endereço não encontrado: confira a URL da API' };
  if (status === 429)
    return { ok: false, error: 'O provedor limitou as requisições (429); tente mais tarde' };
  return { ok: false, error: `O provedor respondeu com erro ${status}` };
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
export async function probeLlm(fetchImpl: Fetch, baseUrl: string, apiKey: string): Promise<ProbeResult> {
  const res = await call(fetchImpl, `${baseUrl}/models`, { authorization: `Bearer ${apiKey}` });
  if (!(res instanceof Response)) return res;
  if (!res.ok) return failure(res.status);
  const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
  const models = Array.isArray(body?.data)
    ? body.data
        .map((m) => (typeof m === 'object' && m && 'id' in m ? String((m as { id: unknown }).id) : ''))
        .filter((id) => id.length > 0 && id.length <= 120)
        .sort()
    : [];
  return { ok: true, models: [...new Set(models)].slice(0, 500) };
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
