import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TokenVerifier } from 'livekit-server-sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadConfig, readSecret } from '@/server/config';
import { AppError, notFound } from '@/server/errors';
import {
  assertSameOrigin,
  clearedCookie,
  clientIp,
  handle,
  json,
  MAX_JSON_BYTES,
  readJson,
  sessionCookie,
} from '@/server/http';
import { JOIN_TOKEN_TTL_SECONDS, issueJoinToken, livekitRoomName } from '@/server/livekit';

const KEY = 'APItestkey';
const SECRET = 'a-very-long-livekit-secret-for-tests-0123456789';
const TENANT = '7a6f2b1e-0000-4000-8000-000000000001';

describe('livekit join token', () => {
  it('namespaces rooms by tenant', () => {
    expect(livekitRoomName(TENANT, 'daily')).toBe(`${TENANT}.daily`);
  });

  it('grants exactly one room, with role attribute, agent dispatch and limits', async () => {
    const jwt = await issueJoinToken({
      apiKey: KEY,
      apiSecret: SECRET,
      tenantId: TENANT,
      roomSlug: 'daily',
      identity: 'u-1',
      displayName: 'Ana',
      role: 'moderator',
      agentName: 'kaiser',
      maxParticipants: 12,
    });
    const claims = await new TokenVerifier(KEY, SECRET).verify(jwt);
    expect(claims.sub).toBe('u-1');
    expect(claims.name).toBe('Ana');
    expect(claims.video).toMatchObject({
      roomJoin: true,
      room: `${TENANT}.daily`,
      canUpdateOwnMetadata: false,
    });
    expect(claims.video?.roomAdmin).toBeFalsy();
    expect(claims.attributes).toEqual({ role: 'moderator' });
    expect(claims.roomConfig?.agents?.[0]?.agentName).toBe('kaiser');
    expect(claims.roomConfig?.maxParticipants).toBe(12);
    expect(Number(claims.exp) - Number(claims.nbf)).toBe(JOIN_TOKEN_TTL_SECONDS);
  });

  it('dispatches no agent unless asked', async () => {
    const jwt = await issueJoinToken({
      apiKey: KEY,
      apiSecret: SECRET,
      tenantId: TENANT,
      roomSlug: 'x',
      identity: 'g-1',
      displayName: 'Guest',
      role: 'guest',
    });
    const claims = await new TokenVerifier(KEY, SECRET).verify(jwt);
    expect(claims.roomConfig?.agents ?? []).toHaveLength(0);
  });

  it('is rejected with another secret', async () => {
    const jwt = await issueJoinToken({
      apiKey: KEY,
      apiSecret: SECRET,
      tenantId: TENANT,
      roomSlug: 'x',
      identity: 'g',
      displayName: 'G',
      role: 'guest',
    });
    await expect(new TokenVerifier(KEY, `${SECRET}-other`).verify(jwt)).rejects.toThrow();
  });
});

function request(headers: Record<string, string>, body?: string): Request {
  return new Request('https://acme.meet.test/api/x', { method: 'POST', headers, body });
}

describe('json responses', () => {
  it.each([
    ['plain object', { 'set-cookie': 's=1' }],
    ['Headers instance', new Headers({ 'set-cookie': 's=1' })],
    ['entry list', [['set-cookie', 's=1']] as [string, string][]],
  ])('keep extra headers given as %s and never cache', (_kind, headers) => {
    const res = json({ ok: true }, 201, headers);
    expect(res.status).toBe(201);
    expect(res.headers.get('set-cookie')).toBe('s=1');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('http helpers', () => {
  it('accepts same-origin requests', () => {
    expect(() =>
      assertSameOrigin(request({ host: 'acme.meet.test', origin: 'https://acme.meet.test' })),
    ).not.toThrow();
  });

  it.each([
    [{ host: 'acme.meet.test' }],
    [{ host: 'acme.meet.test', origin: 'https://evil.test' }],
    [{ host: 'acme.meet.test', origin: 'null' }],
    [{ origin: 'https://acme.meet.test' }],
  ])('rejects cross-origin or missing origin %j', (headers) => {
    expect(() => assertSameOrigin(request(headers as Record<string, string>))).toThrow(AppError);
  });

  it('parses JSON bodies through a schema', async () => {
    const schema = z.object({ a: z.number() });
    await expect(
      readJson(request({ 'content-type': 'application/json' }, '{"a":1}'), schema),
    ).resolves.toEqual({
      a: 1,
    });
    await expect(readJson(request({ 'content-type': 'text/plain' }, '{}'), schema)).rejects.toThrow(
      'Envie JSON',
    );
    await expect(readJson(request({ 'content-type': 'application/json' }, '{'), schema)).rejects.toThrow(
      'JSON inválido',
    );
    const big = JSON.stringify({ a: 'x'.repeat(MAX_JSON_BYTES) });
    await expect(readJson(request({ 'content-type': 'application/json' }, big), schema)).rejects.toThrow(
      'muito grande',
    );
  });

  it('maps errors to JSON without leaking internals', async () => {
    const known = await handle(async () => {
      throw notFound('Sala não encontrada');
    });
    expect(known.status).toBe(404);
    expect(await known.json()).toEqual({ error: { code: 'not_found', message: 'Sala não encontrada' } });

    const zod = await handle(async () => {
      z.object({ a: z.string({ error: 'campo a' }) }).parse({});
      return new Response();
    });
    expect(zod.status).toBe(400);

    const original = console.error;
    console.error = () => {};
    const unknown = await handle(async () => {
      throw new Error('select * from users -- secret detail');
    });
    console.error = original;
    expect(unknown.status).toBe(500);
    expect(JSON.stringify(await unknown.json())).not.toContain('secret');
  });

  it('reads the client IP set by the proxy', () => {
    expect(clientIp(request({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }))).toBe('203.0.113.9');
    expect(clientIp(request({ 'x-real-ip': '203.0.113.7' }))).toBe('203.0.113.7');
    expect(clientIp(request({}))).toBeNull();
  });

  it('builds hardened session cookies', () => {
    const c = sessionCookie('s', 'tok', new Date('2030-01-01T00:00:00Z'), true);
    expect(c).toBe('s=tok; Path=/; HttpOnly; SameSite=Lax; Expires=Tue, 01 Jan 2030 00:00:00 GMT; Secure');
    expect(clearedCookie('s', false)).toBe('s=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  });
});

describe('config', () => {
  const env = {
    DATABASE_URL: 'postgres://u:p@db:5432/meet',
    LIVEKIT_URL: 'wss://livekit.test',
    LIVEKIT_API_KEY: KEY,
    LIVEKIT_API_SECRET: SECRET,
    PLATFORM_DOMAIN: 'Meet.Test',
  };

  it('loads and normalises a valid environment', () => {
    const cfg = loadConfig(env);
    expect(cfg).toMatchObject({ platformDomain: 'meet.test', agentName: 'kaiser', secureCookies: true });
  });

  it('prefers secrets from files', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cfg-'));
    const file = path.join(dir, 'secret');
    writeFileSync(file, `${SECRET}-from-file\n`);
    expect(readSecret({ X_FILE: file, X: 'env' }, 'X')).toBe(`${SECRET}-from-file`);
    expect(() => readSecret({ X_FILE: path.join(dir, 'missing') }, 'X')).toThrow('unreadable');
  });

  it('names invalid fields without echoing values', () => {
    expect(() => loadConfig({ ...env, LIVEKIT_API_SECRET: 'short-secret-value' })).toThrow(
      /^invalid configuration: livekitApiSecret$/,
    );
    expect(() => loadConfig({ ...env, LIVEKIT_URL: 'https://x' })).toThrow('livekitUrl');
  });

  it('allows insecure cookies only when explicitly disabled', () => {
    expect(loadConfig({ ...env, SECURE_COOKIES: 'false' }).secureCookies).toBe(false);
  });
});
