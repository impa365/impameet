import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AppError } from '@/server/errors';
import { type Fetch, probeFish, probeLlm } from '@/server/integrations/probe';
import { assertPublicHttpsUrl, isPublicIp } from '@/server/security/public-url';
import { openSecret, parseMasterKey, sealSecret, secretHint } from '@/server/security/secrets';

const KEY = randomBytes(32);

describe('sealed secrets', () => {
  it('round-trips and never stores the plain value', () => {
    const sealed = sealSecret(KEY, 'sk-live-0123456789abcdef', 'integration:t1:i1');
    expect(sealed.startsWith('enc:v1:')).toBe(true);
    expect(sealed).not.toContain('sk-live');
    expect(openSecret(KEY, sealed, 'integration:t1:i1')).toBe('sk-live-0123456789abcdef');
    expect(sealSecret(KEY, 'same', 'a')).not.toBe(sealSecret(KEY, 'same', 'a'));
  });

  it('refuses another record, another key or a tampered value', () => {
    const sealed = sealSecret(KEY, 'sk-live-0123456789abcdef', 'integration:t1:i1');
    expect(() => openSecret(KEY, sealed, 'integration:t2:i1')).toThrow();
    expect(() => openSecret(randomBytes(32), sealed, 'integration:t1:i1')).toThrow();
    const tampered = sealed.slice(0, -4) + (sealed.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(() => openSecret(KEY, tampered, 'integration:t1:i1')).toThrow();
    expect(() => openSecret(KEY, 'plain-text', 'x')).toThrow(/not a sealed/);
    expect(() => openSecret(KEY, 'enc:v1:abc', 'x')).toThrow(/malformed/);
  });

  it('validates the master key and hints only the last 4 characters', () => {
    expect(parseMasterKey(KEY.toString('base64')).equals(KEY)).toBe(true);
    expect(() => parseMasterKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
    expect(secretHint('sk-live-0123456789abcd')).toBe('••••abcd');
    expect(secretHint('short-key')).toBe('••••');
  });
});

describe('provider URLs', () => {
  it.each([
    ['8.8.8.8', true],
    ['2606:4700::1111', true],
    ['10.0.0.1', false],
    ['172.20.0.5', false],
    ['192.168.1.1', false],
    ['127.0.0.1', false],
    ['169.254.169.254', false],
    ['100.64.0.8', false],
    ['::1', false],
    ['fd00::1', false],
    ['::ffff:10.0.0.1', false],
    ['::ffff:8.8.8.8', true],
    ['nonsense', false],
  ])('%s public=%s', (ip, expected) => {
    expect(isPublicIp(ip)).toBe(expected);
  });

  const resolve = async (host: string) => {
    if (host === 'api.example.com') return ['93.184.215.14'];
    if (host === 'postgres') return ['10.231.0.5'];
    throw new Error('ENOTFOUND');
  };

  it('accepts public https endpoints and normalises them', async () => {
    expect(await assertPublicHttpsUrl(' https://api.example.com/v1/ ', resolve)).toBe(
      'https://api.example.com/v1',
    );
    expect(await assertPublicHttpsUrl('https://8.8.8.8/v1', resolve)).toBe('https://8.8.8.8/v1');
  });

  it.each([
    'not a url',
    'http://api.example.com/v1',
    'https://user:pass@api.example.com/v1',
    'https://postgres:5432',
    'https://nowhere.example/v1',
    'https://127.0.0.1/v1',
  ])('rejects %s', async (url) => {
    await expect(assertPublicHttpsUrl(url, resolve)).rejects.toBeInstanceOf(AppError);
  });
});

function fakeFetch(status: number, body: unknown, seen: { url?: string; auth?: string } = {}): Fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url);
    seen.auth = new Headers(init?.headers).get('authorization') ?? undefined;
    return new Response(JSON.stringify(body), { status });
  }) as Fetch;
}

describe('provider probes', () => {
  it('lists an OpenAI-compatible endpoint models with the key', async () => {
    const seen: { url?: string; auth?: string } = {};
    const res = await probeLlm(
      fakeFetch(200, { data: [{ id: 'gpt-b' }, { id: 'gpt-a' }, { id: 'gpt-a' }, { nope: 1 }] }, seen),
      'https://api.example.com/v1',
      'sk-123456789',
    );
    expect(res).toEqual({ ok: true, models: ['gpt-a', 'gpt-b'] });
    expect(seen).toEqual({ url: 'https://api.example.com/v1/models', auth: 'Bearer sk-123456789' });
    expect(await probeLlm(fakeFetch(200, { other: true }), 'https://x', 'k')).toEqual({
      ok: true,
      models: [],
    });
  });

  it.each([
    [401, 'recusada'],
    [403, 'recusada'],
    [404, 'URL'],
    [429, '429'],
    [500, '500'],
  ])('explains an HTTP %s', async (status, text) => {
    const res = await probeLlm(fakeFetch(status, {}), 'https://x', 'k');
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toContain(text);
  });

  it('checks a Fish Audio key and survives network errors', async () => {
    const seen: { url?: string; auth?: string } = {};
    expect(await probeFish(fakeFetch(200, { credit: '10' }, seen), 'fish-key-123')).toEqual({
      ok: true,
      models: [],
    });
    expect(seen.url).toBe('https://api.fish.audio/wallet/self/api-credit');
    expect((await probeFish(fakeFetch(401, {}), 'bad')).ok).toBe(false);
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as Fetch;
    expect(await probeFish(down, 'k')).toEqual({ ok: false, error: 'Não foi possível conectar ao provedor' });
  });
});
