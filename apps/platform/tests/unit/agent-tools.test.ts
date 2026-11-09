import { AccessToken } from 'livekit-server-sdk';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '@/server/config';
import type { LiveKitAdmin } from '@/server/livekit-admin';
import { joinClaims, setHand } from '@/server/rooms/hand';
import type { Room } from '@/server/rooms/service';
import {
  type ToolParam,
  assertHttpTemplate,
  coerceArgs,
  describeResponse,
  paramsSchema,
  renderHttp,
} from '@/server/tools/http-tool';
import {
  agentInput,
  agentModerationInput,
  agentToolInput,
  agentToolRunInput,
  agentToolTestInput,
  createRoomInput,
  handInput,
  updateRoomInput,
} from '@/server/validation';

const http = (extra: Record<string, unknown> = {}) => ({
  kind: 'http',
  name: 'consultar_pedido',
  description: 'Consulta um pedido',
  method: 'GET',
  url: 'https://api.example.com/orders/{{id}}',
  ...extra,
});

describe('agent tool validation', () => {
  it('defaults to the safest choices: moderators only, confirmation, enabled, 10 s', () => {
    expect(agentToolInput.parse(http())).toMatchObject({
      access: 'moderators',
      confirm: true,
      enabled: true,
      timeoutMs: 10000,
      params: [],
      bodyTemplate: null,
      headers: null,
    });
    expect(
      agentToolInput.parse({ kind: 'mcp', name: 'crm', url: 'https://mcp.example.com/mcp' }),
    ).toMatchObject({
      description: '',
      mcpTools: [],
    });
    const picked = agentToolInput.parse({
      kind: 'mcp',
      name: 'crm',
      url: 'https://x.y/mcp',
      mcpTools: ['a', 'a', 'b'],
    });
    expect(picked.kind === 'mcp' && picked.mcpTools).toEqual(['a', 'b']);
  });

  it('refuses bad names, missing descriptions, repeated or reserved headers and header injection', () => {
    const bad = [
      http({ name: 'Consultar Pedido' }),
      http({ name: 'x' }),
      http({ description: '' }),
      http({ method: 'TRACE' }),
      http({ timeoutMs: 60000 }),
      http({ params: [{ name: '1x', type: 'string' }] }),
      http({ params: [{ name: 'a', type: 'date' }] }),
      http({
        params: [
          { name: 'a', type: 'string' },
          { name: 'a', type: 'number' },
        ],
      }),
      http({ headers: [{ name: 'Host', value: 'x' }] }),
      http({ headers: [{ name: 'Mcp-Session-Id', value: 'x' }] }),
      http({ headers: [{ name: 'X Y', value: 'x' }] }),
      http({ headers: [{ name: 'X-A', value: 'ok\r\nX-B: injected' }] }),
      http({
        headers: [
          { name: 'X-A', value: '1' },
          { name: 'x-a', value: '2' },
        ],
      }),
      http({ access: 'everyone' }),
      { kind: 'stdio', name: 'local', url: 'npx something' },
    ];
    for (const input of bad)
      expect(agentToolInput.safeParse(input).success, JSON.stringify(input)).toBe(false);
  });

  it('runs need the room, the tool and who asked (one to five people)', () => {
    expect(agentToolRunInput.parse({ room: 't.sala', tool: 'x', requestedBy: ['u-1'] }).args).toEqual({});
    expect(agentToolRunInput.safeParse({ room: 't.sala', tool: 'x', requestedBy: [] }).success).toBe(false);
    expect(
      agentToolRunInput.safeParse({ room: 't.sala', tool: 'x', requestedBy: Array(6).fill('u') }).success,
    ).toBe(false);
    expect(agentToolTestInput.parse({}).args).toEqual({});
  });

  it('knows the new agent abilities, all off unless chosen', () => {
    const base = { name: 'Kaiser', instructions: 'x' };
    const parsed = agentInput.safeParse(base);
    // incomplete agents fail on their providers, not on the new fields
    if (!parsed.success) expect(parsed.error.issues.some((i) => i.path[0] === 'perception')).toBe(false);
    for (const action of ['camera', 'record_start', 'record_stop'])
      expect(agentModerationInput.parse({ room: 't.sala', action, target: 'room' }).action).toBe(action);
    expect(createRoomInput.parse({ name: 'Sala' }).agentActions).toBe(true);
    expect(updateRoomInput.parse({ agentActions: false })).toEqual({ agentActions: false });
    expect(handInput.safeParse({ token: 'short', raised: true }).success).toBe(false);
  });

  it('reads the operator allowlist of internal hosts for tools', () => {
    const env = {
      DATABASE_URL: 'postgres://u:p@db/x',
      LIVEKIT_URL: 'wss://lk.example.com',
      LIVEKIT_API_KEY: 'key',
      LIVEKIT_API_SECRET: 's'.repeat(40),
      PLATFORM_DOMAIN: 'meet.example.com',
    };
    expect(loadConfig(env).toolsPrivateHosts).toEqual([]);
    expect(loadConfig({ ...env, AGENT_TOOLS_PRIVATE_HOSTS: ' n8n , CRM-api ,' }).toolsPrivateHosts).toEqual([
      'n8n',
      'crm-api',
    ]);
    expect(() => loadConfig({ ...env, AGENT_TOOLS_PRIVATE_HOSTS: 'bad host!' })).toThrow(/toolsPrivateHosts/);
  });
});

const params: ToolParam[] = [
  { name: 'id', type: 'string', description: 'Número', required: true },
  { name: 'qtd', type: 'integer', description: '', required: false },
  { name: 'preco', type: 'number', description: '', required: false },
  { name: 'urgente', type: 'boolean', description: '', required: false },
];

describe('HTTP tool requests', () => {
  it('shows the model a strict schema', () => {
    expect(paramsSchema(params)).toEqual({
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Número' },
        qtd: { type: 'integer' },
        preco: { type: 'number' },
        urgente: { type: 'boolean' },
      },
      required: ['id'],
      additionalProperties: false,
    });
  });

  it('types the arguments and drops what was not declared', () => {
    expect(coerceArgs(params, { id: 7, qtd: '3', preco: 9.5, urgente: 'false', extra: 'x' })).toEqual({
      id: '7',
      qtd: 3,
      preco: 9.5,
      urgente: false,
    });
    expect(coerceArgs(params, { id: 'a', urgente: true, qtd: null, preco: '' })).toEqual({
      id: 'a',
      urgente: true,
    });
    const fails: [Record<string, unknown>, RegExp][] = [
      [{}, /Falta o parâmetro id/],
      [{ id: { a: 1 } }, /texto/],
      [{ id: 'x'.repeat(2001) }, /longo/],
      [{ id: 'a', qtd: 1.5 }, /inteiro/],
      [{ id: 'a', preco: 'caro' }, /número/],
      [{ id: 'a', preco: [] }, /número/],
      [{ id: 'a', urgente: 'sim' }, /verdadeiro ou falso/],
    ];
    for (const [raw, message] of fails) expect(() => coerceArgs(params, raw)).toThrow(message);
  });

  it('keeps arguments out of the host and refuses undeclared placeholders or bodies on GET', () => {
    const ok = {
      url: 'https://api.example.com/o/{{id}}?q={{qtd}}',
      method: 'GET' as const,
      params,
      bodyTemplate: null,
    };
    expect(() => assertHttpTemplate(ok)).not.toThrow();
    expect(() => assertHttpTemplate({ ...ok, url: 'https://{{id}}.example.com/' })).toThrow(/caminho/);
    expect(() => assertHttpTemplate({ ...ok, url: 'api.example.com:{{id}}/x' })).toThrow(/caminho/);
    expect(() => assertHttpTemplate({ ...ok, url: 'https://api.example.com/{{nope}}' })).toThrow(/declarado/);
    expect(() => assertHttpTemplate({ ...ok, bodyTemplate: '{}' })).toThrow(/corpo/);
    expect(() => assertHttpTemplate({ ...ok, method: 'POST', bodyTemplate: '{"a": "{{nope}}"}' })).toThrow(
      /declarado/,
    );
    expect(() => assertHttpTemplate({ ...ok, method: 'POST', bodyTemplate: 'not json' })).toThrow(/JSON/);
  });

  it('builds the URL, the query and the JSON body', () => {
    const spec = {
      method: 'GET' as const,
      url: 'https://api.example.com/o/{{id}}',
      params,
      bodyTemplate: null,
      headers: { Authorization: 'Bearer k' },
    };
    const get = renderHttp(spec, { id: 'a b/c', qtd: 2, urgente: true });
    expect(get.url).toBe('https://api.example.com/o/a%20b%2Fc?qtd=2&urgente=true');
    expect(get.body).toBeUndefined();
    expect(get.headers).toMatchObject({ Authorization: 'Bearer k' });
    expect(() => renderHttp(spec, { id: '..' })).toThrow(/Valor inválido/);
    expect(() => renderHttp(spec, { id: ' . ' })).toThrow(/Valor inválido/);

    const post = renderHttp({ ...spec, method: 'POST' }, { id: '1', qtd: 2 });
    expect(post.url).toBe('https://api.example.com/o/1');
    expect(JSON.parse(post.body!)).toEqual({ qtd: 2 });
    expect(post.headers['content-type']).toBe('application/json');

    const templated = renderHttp(
      {
        ...spec,
        method: 'PATCH',
        url: 'https://api.example.com/o',
        bodyTemplate:
          '{"id": "{{id}}", "n": "{{qtd}}", "list": ["{{urgente}}", 1], "note": "Pedido {{id}}", "x": null}',
      },
      { id: '9', qtd: 3, urgente: false },
    );
    expect(JSON.parse(templated.body!)).toEqual({
      id: '9',
      n: 3,
      list: [false, 1],
      note: 'Pedido 9',
      x: null,
    });
    const missing = renderHttp(
      {
        ...spec,
        method: 'POST',
        url: 'https://api.example.com/o',
        bodyTemplate: '{"n": "{{qtd}}", "t": "a{{qtd}}b"}',
      },
      { id: '1' },
    );
    expect(JSON.parse(missing.body!)).toEqual({ n: null, t: 'ab' });
  });

  it('reports answers compactly, never following redirects', () => {
    const json = { 'content-type': 'application/json; charset=utf-8' };
    expect(describeResponse({ status: 200, headers: json, body: '{ "a": 1 }\n', truncated: false })).toEqual({
      ok: true,
      output: 'HTTP 200\n{"a":1}',
    });
    expect(describeResponse({ status: 200, headers: json, body: '{bad', truncated: true }).output).toBe(
      'HTTP 200 (resposta cortada)\n{bad',
    );
    expect(
      describeResponse({
        status: 302,
        headers: { location: 'https://elsewhere' },
        body: '',
        truncated: false,
      }),
    ).toEqual({
      ok: false,
      output: 'HTTP 302\nredirecionou para https://elsewhere (redirecionamentos não são seguidos)',
    });
    expect(
      describeResponse({ status: 200, headers: {}, body: 'x'.repeat(9000), truncated: false }).output,
    ).toHaveLength(4000);
  });
});

describe('raising a hand with a join token', () => {
  const cfg = {
    livekitApiKey: 'APIkey',
    livekitApiSecret: 'a-very-long-livekit-secret-for-tests-0123456789',
  };
  const room = { tenantId: 't1', slug: 'aula' } as Room;
  const mint = async (
    identity: string,
    name = 't1.aula',
    grant: Record<string, unknown> = { roomJoin: true },
  ) => {
    const at = new AccessToken(cfg.livekitApiKey, cfg.livekitApiSecret, { identity, ttl: 60 });
    at.addGrant({ room: name, ...grant });
    return at.toJwt();
  };
  const lk = (identities: string[], calls: string[] = []) =>
    ({
      listParticipants: async () =>
        identities.map((identity) => ({ identity, isAgent: identity.startsWith('agent') })),
      setAttributes: async (r: string, i: string, a: Record<string, string>) => {
        calls.push(`${r} ${i} ${a.hand ? 'up' : 'down'}`);
      },
    }) as unknown as LiveKitAdmin;

  it('trusts only well-formed tokens this server signed', async () => {
    const token = await mint('g-eva');
    expect(joinClaims(cfg, token)).toEqual({ identity: 'g-eva', room: 't1.aula' });
    expect(joinClaims({ ...cfg, livekitApiKey: 'other' }, token)).toBeNull();
    expect(joinClaims(cfg, await mint('g-eva', 't1.aula', { roomJoin: false }))).toBeNull();
    expect(joinClaims(cfg, 'a.b')).toBeNull();
    expect(joinClaims(cfg, '%%%.%%%.%%%')).toBeNull();
    const [, body, sig] = token.split('.');
    const none = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    expect(joinClaims(cfg, `${none}.${body}.${sig}`)).toBeNull();
    expect(joinClaims(cfg, token, Date.now() - 10 * 60_000)).toBeNull(); // not valid yet
  });

  it('changes only the hand of whoever is in the call', async () => {
    const calls: string[] = [];
    expect(await setHand(cfg, lk(['g-eva'], calls), room, await mint('g-eva'), true)).toEqual({
      raised: true,
    });
    await setHand(cfg, lk(['g-eva'], calls), room, await mint('g-eva', 't1.aula~2'), false);
    expect(calls).toEqual(['t1.aula g-eva up', 't1.aula~2 g-eva down']);
    await expect(setHand(cfg, lk([]), room, await mint('g-eva'), true)).rejects.toThrow(/não está/);
    await expect(setHand(cfg, lk(['g-eva']), room, await mint('g-eva', 't1.outra'), true)).rejects.toThrow(
      /antes de levantar/,
    );
  });
});
