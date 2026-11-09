import { describe, expect, it } from 'vitest';
import type { Fetch } from '@/server/integrations/probe';
import {
  deepgramVoices,
  elevenLabsVoices,
  fetchVoices,
  fishVoices,
  languageCode,
  matchesQuery,
} from '@/server/integrations/voices';
import { voiceSearchInput } from '@/server/validation';

const ELEVEN = {
  voices: [
    {
      voice_id: 'JBFqnCBsd6RMkjVDRZzb',
      name: 'George',
      category: 'premade',
      description: 'Warm British narrator',
      labels: { gender: 'male', age: 'middle_aged', accent: 'british', language: 'en' },
      verified_languages: [{ language: 'pt' }, { language: 'en' }, { language: 7 }],
      preview_url: 'https://storage.googleapis.com/eleven/george.mp3',
    },
    { voice_id: 'bad id!', name: 'Broken' },
    { voice_id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George again' },
    { voice_id: 'Xb7hH8MSUJpSbSDYk0k2', preview_url: 'javascript:alert(1)' },
    'not an object',
  ],
};

const FISH = {
  total: 4,
  items: [
    {
      _id: '54e3a85ac9594ffa83264b8a494b901b',
      type: 'tts',
      state: 'trained',
      title: 'Ana Brasileira',
      description: 'Voz feminina calma',
      languages: ['pt', 'en'],
      tags: ['female', 'calm', '', 3],
      samples: [{ title: 's', text: 'olá', task_id: 't', audio: 'https://cdn.fish.audio/ana.mp3' }],
    },
    { _id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', type: 'svc', state: 'trained', title: 'Singing' },
    { _id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', type: 'tts', state: 'training', title: 'Not ready' },
    { _id: 'cccccccccccccccccccccccccccccccc', title: '', languages: 'pt' },
  ],
};

const DEEPGRAM = {
  stt: [{ name: 'nova-3', canonical_name: 'nova-3' }],
  tts: [
    {
      name: 'zeus',
      canonical_name: 'aura-2-zeus-en',
      architecture: 'aura-2',
      languages: ['en', 'en-US'],
      metadata: {
        accent: 'American',
        age: 'Adult',
        sample: 'https://static.deepgram.com/examples/Aura-2-zeus.wav',
        tags: ['masculine', 'deep'],
        use_cases: ['IVR', 'Narration'],
      },
    },
    {
      name: 'bianca',
      canonical_name: 'flux-bianca-pt',
      languages: ['pt-BR'],
      metadata: { tags: ['feminine'], sample: 'not a url' },
    },
    { name: '', canonical_name: 'oddvoice', architecture: 'custom', languages: [] },
    { name: 'tiny', canonical_name: 'abc' },
  ],
};

describe('voice listings', () => {
  it('reads ElevenLabs voices: languages, labels, safe samples, valid unique ids', () => {
    expect(elevenLabsVoices(ELEVEN)).toEqual([
      {
        id: 'JBFqnCBsd6RMkjVDRZzb',
        name: 'George',
        languages: ['en', 'pt'],
        tags: ['male', 'middle_aged', 'british', 'premade'],
        description: 'Warm British narrator',
        preview: 'https://storage.googleapis.com/eleven/george.mp3',
      },
      {
        id: 'Xb7hH8MSUJpSbSDYk0k2',
        name: 'Xb7hH8MSUJpSbSDYk0k2',
        languages: [],
        tags: [],
        description: '',
        preview: null,
      },
    ]);
    expect(elevenLabsVoices(null)).toEqual([]);
    expect(elevenLabsVoices({ voices: 'nope' })).toEqual([]);
  });

  it('reads Fish Audio voices: only trained text-to-speech ones', () => {
    expect(fishVoices(FISH)).toEqual([
      {
        id: '54e3a85ac9594ffa83264b8a494b901b',
        name: 'Ana Brasileira',
        languages: ['pt', 'en'],
        tags: ['female', 'calm'],
        description: 'Voz feminina calma',
        preview: 'https://cdn.fish.audio/ana.mp3',
      },
      {
        id: 'cccccccccccccccccccccccccccccccc',
        name: 'cccccccccccccccccccccccccccccccc',
        languages: [],
        tags: [],
        description: '',
        preview: null,
      },
    ]);
    expect(fishVoices({})).toEqual([]);
  });

  it('reads Deepgram voices with their family', () => {
    expect(deepgramVoices(DEEPGRAM)).toEqual([
      {
        id: 'aura-2-zeus-en',
        name: 'Zeus',
        languages: ['en'],
        tags: ['American', 'Adult', 'masculine', 'deep'],
        description: 'IVR, Narration',
        preview: 'https://static.deepgram.com/examples/Aura-2-zeus.wav',
        family: 'aura-2',
      },
      {
        id: 'flux-bianca-pt',
        name: 'Bianca',
        languages: ['pt'],
        tags: ['feminine'],
        description: '',
        preview: null,
        family: 'flux',
      },
      {
        id: 'oddvoice',
        name: 'oddvoice',
        languages: [],
        tags: [],
        description: '',
        preview: null,
        family: 'custom',
      },
    ]);
    expect(deepgramVoices({ tts: {} })).toEqual([]);
  });

  it('normalizes language codes and names', () => {
    expect(
      ['pt-BR', 'PT', 'Portuguese', 'português', 'en_US', 'Spanish', 'espanhol', 'de'].map(languageCode),
    ).toEqual(['pt', 'pt', 'pt', 'pt', 'en', 'es', 'es', 'de']);
  });

  it('matches every word of a search in name, id, tags or description', () => {
    const [zeus] = deepgramVoices(DEEPGRAM);
    expect(matchesQuery(zeus, '')).toBe(true);
    expect(matchesQuery(zeus, 'DEEP american')).toBe(true);
    expect(matchesQuery(zeus, 'aura-2 narration')).toBe(true);
    expect(matchesQuery(zeus, 'deep british')).toBe(false);
  });
});

describe('fetching voices', () => {
  function recorder(body: unknown, status = 200) {
    const seen: { url: string; headers: Headers }[] = [];
    const impl = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: new Headers(init.headers) });
      expect(init.redirect).toBe('error');
      return new Response(JSON.stringify(body), { status });
    }) as unknown as Fetch;
    return { seen, impl };
  }

  it('asks ElevenLabs with the xi-api-key header and the search', async () => {
    const { seen, impl } = recorder(ELEVEN);
    const res = await fetchVoices(impl, 'elevenlabs', 'el-key', { query: 'george', scope: 'mine' });
    expect(res.ok && res.voices.map((v) => v.name)).toEqual(['George', 'Xb7hH8MSUJpSbSDYk0k2']);
    expect(seen[0].url).toBe(
      'https://api.elevenlabs.io/v2/voices?page_size=100&include_total_count=false&search=george',
    );
    expect(seen[0].headers.get('xi-api-key')).toBe('el-key');
  });

  it('asks Fish Audio for the account voices or the public library in a language', async () => {
    const mine = recorder(FISH);
    await fetchVoices(mine.impl, 'fish', 'fish-key', { query: '', scope: 'mine', language: 'pt' });
    expect(mine.seen[0].url).toBe('https://api.fish.audio/model?page_size=100&self=true');
    expect(mine.seen[0].headers.get('authorization')).toBe('Bearer fish-key');
    const pub = recorder(FISH);
    const res = await fetchVoices(pub.impl, 'fish', 'fish-key', {
      query: 'ana',
      scope: 'public',
      language: 'pt',
      licensed: true,
    });
    expect(pub.seen[0].url).toBe(
      'https://api.fish.audio/model?page_size=100&sort_by=task_count&title=ana&language=pt&licensed=true',
    );
    expect(res.ok && res.voices).toHaveLength(2);
    const open = recorder(FISH);
    await fetchVoices(open.impl, 'fish', 'fish-key', { query: '', scope: 'public', licensed: false });
    expect(open.seen[0].url).toBe('https://api.fish.audio/model?page_size=100&sort_by=task_count');
  });

  it('lists Deepgram voices with the Token scheme and filters them locally', async () => {
    const { seen, impl } = recorder(DEEPGRAM);
    const res = await fetchVoices(impl, 'deepgram', 'dg-key', { query: 'feminine', scope: 'mine' });
    expect(res.ok && res.voices.map((v) => v.id)).toEqual(['flux-bianca-pt']);
    expect(seen[0].url).toBe('https://api.deepgram.com/v1/models');
    expect(seen[0].headers.get('authorization')).toBe('Token dg-key');
  });

  it('explains refused keys, rate limits, other errors and network failures', async () => {
    const q = { query: '', scope: 'mine' as const };
    expect(await fetchVoices(recorder({}, 401).impl, 'fish', 'k', q)).toEqual({
      ok: false,
      error: 'A chave foi recusada pelo provedor',
    });
    expect(await fetchVoices(recorder({}, 429).impl, 'elevenlabs', 'k', q)).toMatchObject({ ok: false });
    expect(await fetchVoices(recorder({}, 500).impl, 'deepgram', 'k', q)).toEqual({
      ok: false,
      error: 'O provedor respondeu com erro 500',
    });
    const down = (async () => {
      throw new Error('offline');
    }) as unknown as Fetch;
    expect(await fetchVoices(down, 'deepgram', 'k', q)).toEqual({
      ok: false,
      error: 'Não foi possível conectar ao provedor',
    });
    const garbage = (async () => new Response('<html>', { status: 200 })) as unknown as Fetch;
    expect(await fetchVoices(garbage, 'fish', 'k', q)).toEqual({ ok: true, voices: [] });
  });

  it('validates the search the form sends', () => {
    expect(voiceSearchInput.parse({})).toEqual({ query: '', scope: 'mine', licensed: true });
    expect(
      voiceSearchInput.parse({ query: '  ana ', scope: 'public', language: 'pt', licensed: false }),
    ).toEqual({ query: 'ana', scope: 'public', language: 'pt', licensed: false });
    expect(voiceSearchInput.safeParse({ language: 'fr' }).success).toBe(false);
    expect(voiceSearchInput.safeParse({ query: 'x'.repeat(81) }).success).toBe(false);
  });
});
