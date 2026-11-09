/** The voices a speech key can use, read live from the provider, with a sample to listen to. */

import { DEEPGRAM_API_URL, ELEVENLABS_API_URL, FISH_API_URL, type Fetch } from './probe';

export interface Voice {
  /** What goes in the agent's voice field (Deepgram: the full model name). */
  id: string;
  name: string;
  /** Two-letter codes when the provider says which languages the voice speaks. */
  languages: string[];
  tags: string[];
  description: string;
  /** An https audio sample, or null. */
  preview: string | null;
  /** Deepgram: the voice family (flux, aura-2), to match the chosen voice model. */
  family?: string;
}

export type VoicesResult = { ok: true; voices: Voice[] } | { ok: false; error: string };

export interface VoiceQuery {
  query: string;
  /** Fish Audio: the account's own voices, or its public library. */
  scope: 'mine' | 'public';
  language?: string;
  /** Fish Audio's public library: only voices whose owner granted the rights. */
  licensed?: boolean;
}

const TIMEOUT_MS = 10_000;
const MAX_VOICES = 200;
/** Same shape the agent form accepts for a voice. */
const VOICE_ID = /^[A-Za-z0-9_-]{4,64}$/;

const LANGUAGE_NAMES: Record<string, string> = {
  portuguese: 'pt',
  'brazilian portuguese': 'pt',
  português: 'pt',
  portugues: 'pt',
  english: 'en',
  inglês: 'en',
  ingles: 'en',
  spanish: 'es',
  español: 'es',
  espanol: 'es',
  espanhol: 'es',
};

/** "pt-BR", "Portuguese" and "pt" all become "pt". */
export function languageCode(raw: string): string {
  const s = raw.trim().toLowerCase();
  return LANGUAGE_NAMES[s] ?? s.split(/[-_]/)[0];
}

function httpsUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

const text = (raw: unknown, max = 200) => (typeof raw === 'string' ? raw.trim().slice(0, max) : '');
const strings = (raw: unknown) =>
  Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : [];
const unique = (list: string[]) => [...new Set(list)];
const record = (raw: unknown): Record<string, unknown> =>
  typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};

function failure(status: number): VoicesResult {
  if (status === 401 || status === 403) return { ok: false, error: 'A chave foi recusada pelo provedor' };
  if (status === 429)
    return { ok: false, error: 'O provedor limitou as requisições (429); tente mais tarde' };
  return { ok: false, error: `O provedor respondeu com erro ${status}` };
}

async function getJson(
  fetchImpl: Fetch,
  url: string,
  headers: Record<string, string>,
): Promise<{ body: unknown } | VoicesResult> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { ...headers, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
  } catch {
    return { ok: false, error: 'Não foi possível conectar ao provedor' };
  }
  if (!res.ok) return failure(res.status);
  return { body: await res.json().catch(() => null) };
}

const usable = (voices: Voice[]): Voice[] => {
  const seen = new Set<string>();
  return voices
    .filter((v) => {
      if (!VOICE_ID.test(v.id) || seen.has(v.id)) return false;
      seen.add(v.id);
      return true;
    })
    .slice(0, MAX_VOICES);
};

export function elevenLabsVoices(body: unknown): Voice[] {
  return usable(
    (Array.isArray(record(body).voices) ? (record(body).voices as unknown[]) : []).map((raw) => {
      const v = record(raw);
      const labels = record(v.labels);
      const verified = Array.isArray(v.verified_languages) ? (v.verified_languages as unknown[]) : [];
      return {
        id: text(v.voice_id, 80),
        name: text(v.name, 80) || text(v.voice_id, 80),
        languages: unique(
          [labels.language, ...verified.map((l) => record(l).language)]
            .filter((l): l is string => typeof l === 'string' && l !== '')
            .map(languageCode),
        ),
        tags: unique(
          [labels.gender, labels.age, labels.accent, labels.use_case, labels.descriptive, v.category]
            .map((l) => text(l, 40))
            .filter(Boolean),
        ),
        description: text(v.description),
        preview: httpsUrl(v.preview_url),
      };
    }),
  );
}

export function fishVoices(body: unknown): Voice[] {
  return usable(
    (Array.isArray(record(body).items) ? (record(body).items as unknown[]) : [])
      .map(record)
      .filter(
        (v) => (v.type === undefined || v.type === 'tts') && (v.state === undefined || v.state === 'trained'),
      )
      .map((v) => {
        const samples = Array.isArray(v.samples) ? (v.samples as unknown[]) : [];
        return {
          id: text(v._id, 80),
          name: text(v.title, 80) || text(v._id, 80),
          languages: unique(strings(v.languages).map(languageCode)),
          tags: strings(v.tags).slice(0, 6),
          description: text(v.description),
          preview: httpsUrl(samples.map((s) => record(s).audio).find((a) => typeof a === 'string')),
        };
      }),
  );
}

export function deepgramVoices(body: unknown): Voice[] {
  return usable(
    (Array.isArray(record(body).tts) ? (record(body).tts as unknown[]) : []).map((raw) => {
      const v = record(raw);
      const meta = record(v.metadata);
      const id = text(v.canonical_name, 80);
      const name = text(v.name, 80);
      return {
        id,
        name: name ? name[0].toUpperCase() + name.slice(1) : id,
        languages: unique(strings(v.languages).map(languageCode)),
        tags: unique([meta.accent, meta.age, ...strings(meta.tags)].map((l) => text(l, 40)).filter(Boolean)),
        description: strings(meta.use_cases).join(', ').slice(0, 200),
        preview: httpsUrl(meta.sample),
        // "aura-2-zeus-en" belongs to aura-2, "flux-bianca-pt" to flux.
        family: id.split('-').slice(0, -2).join('-') || text(v.architecture, 40),
      };
    }),
  );
}

/** Words of the search found in the name, tags or description (Deepgram has no search). */
export function matchesQuery(voice: Voice, query: string): boolean {
  const hay = [voice.name, voice.id, voice.description, ...voice.tags].join(' ').toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

export async function fetchVoices(
  fetchImpl: Fetch,
  kind: 'fish' | 'deepgram' | 'elevenlabs',
  apiKey: string,
  q: VoiceQuery,
): Promise<VoicesResult> {
  if (kind === 'elevenlabs') {
    const params = new URLSearchParams({ page_size: '100', include_total_count: 'false' });
    if (q.query) params.set('search', q.query);
    const res = await getJson(fetchImpl, `${ELEVENLABS_API_URL}/v2/voices?${params}`, {
      'xi-api-key': apiKey,
    });
    return 'body' in res ? { ok: true, voices: elevenLabsVoices(res.body) } : res;
  }
  if (kind === 'fish') {
    const params = new URLSearchParams({ page_size: '100' });
    if (q.scope === 'mine') params.set('self', 'true');
    else params.set('sort_by', 'task_count');
    if (q.query) params.set('title', q.query);
    if (q.scope === 'public' && q.language) params.set('language', q.language);
    if (q.scope === 'public' && q.licensed) params.set('licensed', 'true');
    const res = await getJson(fetchImpl, `${FISH_API_URL}/model?${params}`, {
      authorization: `Bearer ${apiKey}`,
    });
    return 'body' in res ? { ok: true, voices: fishVoices(res.body) } : res;
  }
  const res = await getJson(fetchImpl, `${DEEPGRAM_API_URL}/v1/models`, { authorization: `Token ${apiKey}` });
  if (!('body' in res)) return res;
  return { ok: true, voices: deepgramVoices(res.body).filter((v) => matchesQuery(v, q.query)) };
}
