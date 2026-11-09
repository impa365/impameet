import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AccessToken } from 'livekit-server-sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listAgents, updateAgent } from '@/server/agents/service';
import { signup } from '@/server/auth/service';
import type { SessionUser } from '@/server/auth/session';
import type { Sql } from '@/server/db';
import { AppError } from '@/server/errors';
import type { LiveKitAdmin, LiveParticipant } from '@/server/livekit-admin';
import { issueJoinToken } from '@/server/livekit';
import { joinClaims, setHand } from '@/server/rooms/hand';
import { createRoom } from '@/server/rooms/service';
import { hashPassword } from '@/server/security/password';
import {
  type ToolDeps,
  createAgentTool,
  deleteAgentTool,
  listAgentTools,
  runAgentTool,
  testAgentTool,
  updateAgentTool,
  workerTools,
} from '@/server/tools/service';
import { agentInput, agentToolInput, agentToolRunInput, createRoomInput } from '@/server/validation';
import { type TestSql, freshDatabase } from './db';
import { agentChoices } from './ready-agent';

let sql: TestSql;
const db = () => sql as unknown as Sql;
const PASSWORD = 'senha-muito-segura';
const cfg = { livekitApiKey: 'APIkey', livekitApiSecret: 'a-very-long-livekit-secret-for-tests-0123456789' };

class FakeLiveKit implements LiveKitAdmin {
  rooms = new Map<string, LiveParticipant[]>();
  calls: string[] = [];
  participant(identity: string, extra: Partial<LiveParticipant> = {}): LiveParticipant {
    return {
      identity,
      name: identity,
      role: 'participant',
      isAgent: false,
      handRaised: false,
      audioTrackSids: [],
      audioMuted: true,
      joinedAt: 0,
      ...extra,
    };
  }
  async listParticipants(room: string) {
    return this.rooms.get(room) ?? [];
  }
  async listRooms() {
    return [];
  }
  async muteAudio() {}
  async remove() {}
  async setRole() {}
  async setAttributes(room: string, identity: string, attributes: Record<string, string>) {
    this.calls.push(`${room} ${identity} ${JSON.stringify(attributes)}`);
  }
  async dispatchAgent() {}
  async sendData() {}
}

async function expectAppError(promise: Promise<unknown>, status: number, message?: RegExp) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).status).toBe(status);
  if (message) expect((err as AppError).message).toMatch(message);
}

/** Local stand-ins for the tools: an HTTP API and an MCP server, both behind "tools.test". */
interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}
const seen: Seen[] = [];
let port = 0;
const dns = new Map<string, string[]>();
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c: Buffer) => {
    body += c.toString('utf8');
  });
  req.on('end', () => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/mcp') return mcp(req, res, body);
    if (url.pathname.startsWith('/orders/')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ order: decodeURIComponent(url.pathname.slice(8)), status: 'enviado' }));
    }
    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
      return res.end();
    }
    if (url.pathname === '/big') return res.end('x'.repeat(600 * 1024));
    if (url.pathname === '/slow') return setTimeout(() => res.end('late'), 3000);
    if (url.pathname === '/fail') {
      res.writeHead(500);
      return res.end('boom');
    }
    res.end('ok');
  });
});

function mcp(req: http.IncomingMessage, res: http.ServerResponse, body: string) {
  if (req.headers.authorization !== 'Bearer mcp-secret') {
    res.writeHead(401);
    return res.end();
  }
  if (req.method === 'DELETE') return res.end();
  const msg = JSON.parse(body) as { id?: number; method: string; params?: Record<string, unknown> };
  if (msg.method === 'notifications/initialized') {
    res.writeHead(202);
    return res.end();
  }
  if (msg.method === 'initialize') {
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
    return res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: { protocolVersion: '2025-06-18', capabilities: {} },
      }),
    );
  }
  if (req.headers['mcp-session-id'] !== 'sess-1') {
    res.writeHead(400);
    return res.end();
  }
  if (msg.method === 'tools/list') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [
            {
              name: 'buscar_cliente',
              description: 'Busca um cliente pelo e-mail',
              inputSchema: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] },
            },
            { name: 'apagar_tudo', description: 'Apaga a base', inputSchema: { type: 'object' } },
          ],
        },
      }),
    );
  }
  if (msg.method === 'tools/call') {
    // Streamed reply on a connection the server leaves open: the client must stop on its own.
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const args = (msg.params?.arguments ?? {}) as { email?: string };
    res.write(
      `event: message\ndata: ${JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: `Cliente ${args.email}: plano Pro` }] },
      })}\n\n`,
    );
    return setTimeout(() => res.end(), 5000);
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown method' } }));
}

const KEY = randomBytes(32);
const deps = (): ToolDeps => ({
  sql: db(),
  key: KEY,
  net: { privateHosts: new Set(['tools.test']), resolve: async (h) => dns.get(h) ?? [] },
});
const base = () => `http://tools.test:${port}`;

beforeAll(async () => {
  sql = await freshDatabase();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await sql?.end({ timeout: 5 });
});
beforeEach(async () => {
  await sql`truncate tenants, audit_log restart identity cascade`;
  seen.length = 0;
  dns.clear();
  dns.set('tools.test', ['127.0.0.1']);
  dns.set('api.example.com', ['93.184.215.14']);
});

async function addUser(tenantId: string, email: string, role: SessionUser['role'], status = 'active') {
  const [u] = await sql<SessionUser[]>`
    insert into users (tenant_id, email, name, password_hash, role, status)
    values (${tenantId}, ${email}, ${email.split('@')[0]}, ${await hashPassword(PASSWORD)}, ${role}, ${status})
    returning id, tenant_id as "tenantId", email, name, role, is_superadmin as "isSuperadmin"`;
  return u;
}

async function setup() {
  const { tenant, user: admin } = await signup(
    db(),
    { organization: 'Acme', slug: 'acme', name: 'Admin', email: 'admin@acme.test', password: PASSWORD },
    null,
    'enterprise',
  );
  const [kaiser] = await listAgents(db(), admin);
  const choices = await agentChoices(db(), admin);
  await updateAgent(
    db(),
    admin,
    kaiser.id,
    agentInput.parse({ name: 'Kaiser', instructions: 'x', ...choices }),
    null,
  );
  const room = await createRoom(
    db(),
    admin,
    createRoomInput.parse({ name: 'Aula', agentIds: [kaiser.id] }),
    null,
  );
  const member = await addUser(tenant.id, 'bia@acme.test', 'member');
  const promoted = await addUser(tenant.id, 'caio@acme.test', 'member');
  const disabled = await addUser(tenant.id, 'davi@acme.test', 'member', 'disabled');
  const lkRoom = `${tenant.id}.${room.slug}`;
  const lk = new FakeLiveKit();
  const people = {
    admin: lk.participant(`u-${admin.id}-a1`, { name: 'Admin' }),
    member: lk.participant(`u-${member.id}-b1`, { name: 'Bia' }),
    promoted: lk.participant(`u-${promoted.id}-c1`, { name: 'Caio', role: 'moderator' }),
    disabled: lk.participant(`u-${disabled.id}-d1`, { name: 'Davi' }),
    guest: lk.participant('g-eva', { name: 'Eva', role: 'guest' }),
    guestModerator: lk.participant('g-fred', { name: 'Fred', role: 'moderator' }),
    bot: lk.participant('agent-AJ_1', { name: 'Kaiser', isAgent: true }),
  };
  lk.rooms.set(lkRoom, Object.values(people));
  const tool = (input: Record<string, unknown>) =>
    createAgentTool(deps(), admin, kaiser.id, agentToolInput.parse(input), null);
  const run = (input: Record<string, unknown>) =>
    runAgentTool(deps(), lk, kaiser.id, agentToolRunInput.parse({ room: lkRoom, ...input }));
  return { tenant, admin, member, kaiser, room, lkRoom, lk, people, tool, run };
}

const orderTool = (extra: Record<string, unknown> = {}) => ({
  kind: 'http',
  name: 'consultar_pedido',
  description: 'Consulta o status de um pedido',
  method: 'GET',
  url: `${base()}/orders/{{id}}`,
  params: [
    { name: 'id', type: 'string', required: true, description: 'Número do pedido' },
    { name: 'detalhe', type: 'boolean' },
  ],
  headers: [{ name: 'Authorization', value: 'Bearer http-secret-0123456789' }],
  ...extra,
});

describe('raising a hand: only the server writes attributes', () => {
  it('join tokens no longer let people change their own attributes (role, hand, name)', async () => {
    const token = await issueJoinToken({
      apiKey: cfg.livekitApiKey,
      apiSecret: cfg.livekitApiSecret,
      tenantId: 't1',
      roomSlug: 'aula',
      identity: 'g-eva',
      displayName: 'Eva',
      role: 'guest',
    });
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as {
      video: { canUpdateOwnMetadata?: boolean };
    };
    expect(payload.video.canUpdateOwnMetadata).toBe(false);
  });

  it('accepts only tokens this server signed, for this room, from someone in the call', async () => {
    const { room, lk, lkRoom, tenant } = await setup();
    const mint = (identity: string, roomName: string, secret = cfg.livekitApiSecret, ttl = 60) => {
      const at = new AccessToken(cfg.livekitApiKey, secret, { identity, ttl });
      at.addGrant({ roomJoin: true, room: roomName });
      return at.toJwt();
    };
    const eva = await mint('g-eva', lkRoom);
    expect(joinClaims(cfg, eva)).toEqual({ identity: 'g-eva', room: lkRoom });
    expect(
      joinClaims(cfg, await mint('g-eva', lkRoom, 'another-secret-that-is-long-enough-0123456789')),
    ).toBeNull();
    expect(joinClaims(cfg, `${eva.split('.').slice(0, 2).join('.')}.AAAA`)).toBeNull();
    expect(joinClaims(cfg, eva, Date.now() + 13 * 60 * 60 * 1000)).toBeNull(); // long expired

    expect(await setHand(cfg, lk, room, eva, true)).toEqual({ raised: true });
    expect(lk.calls[0]).toMatch(new RegExp(`^${lkRoom.replace('.', '\\.')} g-eva \\{"hand":"\\d+"\\}$`));
    await setHand(cfg, lk, room, eva, false);
    expect(lk.calls[1]).toBe(`${lkRoom} g-eva {"hand":""}`);

    await expectAppError(setHand(cfg, lk, room, await mint('g-nobody', lkRoom), true), 403, /não está/);
    await expectAppError(setHand(cfg, lk, room, await mint('g-eva', `${tenant.id}.outra`), true), 403);
    await expectAppError(setHand(cfg, lk, room, await mint('agent-AJ_1', lkRoom), true), 403);
    await expectAppError(setHand(cfg, lk, room, 'not.a.token', true), 403);
    // breakout rooms of the same meeting are fine
    lk.rooms.set(`${lkRoom}~1`, [lk.participant('g-eva')]);
    await setHand(cfg, lk, room, await mint('g-eva', `${lkRoom}~1`), true);
    expect(lk.calls).toHaveLength(3);
  });
});

describe('external tools for AI agents', () => {
  it('only admins configure them; header values are sealed and never shown', async () => {
    const { tool, kaiser, member, admin } = await setup();
    const saved = await tool(orderTool());
    expect(saved).toMatchObject({
      name: 'consultar_pedido',
      access: 'moderators',
      confirm: true,
      enabled: true,
    });
    expect(saved.headerNames).toEqual(['Authorization']);
    expect(JSON.stringify(saved)).not.toContain('http-secret');
    const [row] = await sql<{ headers_sealed: string }[]>`select headers_sealed from agent_tools`;
    expect(row.headers_sealed).toMatch(/^enc:v1:/);
    expect(row.headers_sealed).not.toContain('http-secret');

    await expectAppError(listAgentTools(db(), member, kaiser.id), 403);
    await expectAppError(
      createAgentTool(deps(), member, kaiser.id, agentToolInput.parse(orderTool({ name: 'outra' })), null),
      403,
    );
    await expectAppError(tool(orderTool()), 409);

    // an empty value keeps the saved secret; leaving headers out keeps all of them
    const edited = await updateAgentTool(
      deps(),
      admin,
      kaiser.id,
      saved.id,
      agentToolInput.parse(orderTool({ headers: [{ name: 'Authorization', value: '' }], access: 'members' })),
      null,
    );
    expect(edited.access).toBe('members');
    await updateAgentTool(
      deps(),
      admin,
      kaiser.id,
      saved.id,
      agentToolInput.parse(orderTool({ headers: null })),
      null,
    );
    const test = await testAgentTool(deps(), admin, kaiser.id, saved.id, { id: 'A1' });
    expect(test.ok).toBe(true);
    expect(seen.at(-1)?.headers.authorization).toBe('Bearer http-secret-0123456789');

    await deleteAgentTool(db(), admin, kaiser.id, saved.id, null);
    expect(await listAgentTools(db(), admin, kaiser.id)).toEqual([]);
  });

  it('refuses URLs that reach internal services or let arguments pick the host', async () => {
    const { tool } = await setup();
    dns.set('internal.example.com', ['10.0.0.5']);
    const bad = [
      { url: 'http://api.example.com/x', error: /https/ },
      { url: 'https://internal.example.com/x', error: /público/ },
      { url: 'https://127.0.0.1/x', error: /público/ },
      { url: 'https://user:pw@api.example.com/x', error: /usuário/ },
      { url: 'https://{{id}}.example.com/x', error: /caminho ou na consulta/ },
      { url: 'https://api.example.com/{{nada}}', error: /não foi declarado/ },
    ];
    for (const { url, error } of bad) await expectAppError(tool(orderTool({ url })), 400, error);
    await expectAppError(
      tool(orderTool({ url: 'https://api.example.com/x', bodyTemplate: '{"a":1}' })),
      400,
      /corpo/,
    );
    await expectAppError(
      tool(orderTool({ url: 'https://api.example.com/x', method: 'POST', bodyTemplate: '{nope' })),
      400,
      /JSON/,
    );
    expect(() => agentToolInput.parse(orderTool({ headers: [{ name: 'Host', value: 'x' }] }))).toThrow(
      /definido pela plataforma/,
    );
    expect(() =>
      agentToolInput.parse(orderTool({ headers: [{ name: 'X-A', value: 'a\r\nHost: b' }] })),
    ).toThrow(/inválido/);
    expect((await tool(orderTool({ url: 'https://api.example.com/orders/{{id}}' }))).name).toBe(
      'consultar_pedido',
    );
  });

  it('runs an HTTP tool only for people allowed to ask, never for guests', async () => {
    const { tool, run, people, room } = await setup();
    await tool(orderTool());
    const call = (requestedBy: string[]) =>
      run({ tool: 'consultar_pedido', args: { id: 'A 1/2', detalhe: 'true', extra: 'x' }, requestedBy });

    await expectAppError(call([people.guest.identity]), 403, /Convidados/);
    await expectAppError(call([people.guestModerator.identity]), 403, /Convidados/); // promoted guest
    await expectAppError(call([people.member.identity]), 403, /moderadores/);
    await expectAppError(call([people.disabled.identity]), 403, /Convidados/);
    await expectAppError(call([people.bot.identity]), 403, /não está/);
    await expectAppError(call(['u-00000000-0000-0000-0000-000000000000-x']), 403, /não está/);
    // a guest speaking in the same turn as a moderator blocks the call
    await expectAppError(call([people.admin.identity, people.guest.identity]), 403, /Convidados/);
    expect(seen).toHaveLength(0);

    const answer = await call([people.admin.identity]);
    expect(answer).toEqual({ ok: true, output: 'HTTP 200\n{"order":"A 1/2","status":"enviado"}' });
    expect(seen[0].method).toBe('GET');
    expect(seen[0].url).toBe('/orders/A%201%2F2?detalhe=true');
    expect(seen[0].headers.authorization).toBe('Bearer http-secret-0123456789');
    expect((await call([people.promoted.identity])).ok).toBe(true); // member moderating this call

    const [entry] = await sql<
      { action: string; target: string; meta: Record<string, unknown>; actor_id: string }[]
    >`
      select action, target, meta, actor_id from audit_log where action = 'agent.tool' order by id limit 1`;
    expect(entry.target).toBe(`${room.slug}:consultar_pedido`);
    expect(entry.meta).toMatchObject({
      via: 'ai',
      agent: 'Kaiser',
      requestedBy: 'Admin',
      ok: true,
      status: 200,
    });
    expect(JSON.stringify(entry.meta)).not.toMatch(/A 1\/2|secret/);
  });

  it('"members" tools serve signed-in members, still never guests', async () => {
    const { tool, run, people } = await setup();
    await tool(orderTool({ access: 'members' }));
    const call = (who: string) => run({ tool: 'consultar_pedido', args: { id: '7' }, requestedBy: [who] });
    expect((await call(people.member.identity)).ok).toBe(true);
    await expectAppError(call(people.guest.identity), 403, /Convidados/);
  });

  it('builds bodies from the template, reports failures and keeps the model output small', async () => {
    const { tool, run, people } = await setup();
    await tool(
      orderTool({
        name: 'abrir_chamado',
        method: 'POST',
        url: `${base()}/tickets`,
        params: [
          { name: 'titulo', type: 'string', required: true },
          { name: 'prioridade', type: 'integer' },
        ],
        bodyTemplate: '{"title": "{{titulo}}", "priority": "{{prioridade}}", "note": "via IA: {{titulo}}"}',
      }),
    );
    const by = [people.admin.identity];
    expect(
      (await run({ tool: 'abrir_chamado', args: { titulo: 'Sem som', prioridade: 2 }, requestedBy: by })).ok,
    ).toBe(true);
    expect(JSON.parse(seen[0].body)).toEqual({ title: 'Sem som', priority: 2, note: 'via IA: Sem som' });
    expect(seen[0].headers['content-type']).toBe('application/json');

    const missing = await run({ tool: 'abrir_chamado', args: {}, requestedBy: by });
    expect(missing).toEqual({ ok: false, output: 'Falta o parâmetro titulo' });
    const typed = await run({
      tool: 'abrir_chamado',
      args: { titulo: 'x', prioridade: 1.5 },
      requestedBy: by,
    });
    expect(typed.output).toMatch(/número inteiro/);

    for (const [name, path] of [
      ['redirecionar', '/redirect'],
      ['grande', '/big'],
      ['falha', '/fail'],
      ['lenta', '/slow'],
    ]) {
      await tool(orderTool({ name, url: `${base()}${path}`, params: [], timeoutMs: 1000 }));
    }
    const redirect = await run({ tool: 'redirecionar', args: {}, requestedBy: by });
    expect(redirect.output).toMatch(/^HTTP 302\nredirecionou .* não são seguidos/);
    expect(seen.filter((s) => s.url.includes('meta-data'))).toHaveLength(0);
    const big = await run({ tool: 'grande', args: {}, requestedBy: by });
    expect(big.output.length).toBeLessThanOrEqual(4000);
    expect(big.output).toMatch(/^HTTP 200 \(resposta cortada\)/);
    expect(await run({ tool: 'falha', args: {}, requestedBy: by })).toEqual({
      ok: false,
      output: 'HTTP 500\nboom',
    });
    expect(await run({ tool: 'lenta', args: {}, requestedBy: by })).toEqual({
      ok: false,
      output: 'A ferramenta demorou demais para responder',
    });
  });

  it('checks the address again when connecting (a name re-pointed inside is refused)', async () => {
    const { tool, run, people } = await setup();
    await tool(orderTool({ url: 'https://api.example.com/orders/{{id}}' }));
    dns.set('api.example.com', ['127.0.0.1']);
    expect(
      await run({ tool: 'consultar_pedido', args: { id: '1' }, requestedBy: [people.admin.identity] }),
    ).toEqual({ ok: false, output: 'A URL precisa apontar para um endereço público na internet' });
    expect(
      (await run({ tool: 'consultar_pedido', args: { id: '..' }, requestedBy: [people.admin.identity] }))
        .output,
    ).toMatch(/Valor inválido/);
  });

  it('offers and runs only the MCP tools the admin picked', async () => {
    const { tool, run, people, admin, kaiser, lkRoom, lk } = await setup();
    const saved = await tool({
      kind: 'mcp',
      name: 'crm',
      description: 'CRM da empresa',
      url: `${base()}/mcp`,
      headers: [{ name: 'Authorization', value: 'Bearer mcp-secret' }],
    });
    const listed = await testAgentTool(deps(), admin, kaiser.id, saved.id, {});
    expect(listed.tools?.map((t) => t.name)).toEqual(['buscar_cliente', 'apagar_tudo']);
    // nothing picked yet: the agent gets nothing from this server
    expect(await workerTools(deps(), kaiser.id, lkRoom)).toEqual([]);

    await updateAgentTool(
      deps(),
      admin,
      kaiser.id,
      saved.id,
      agentToolInput.parse({
        kind: 'mcp',
        name: 'crm',
        description: 'CRM da empresa',
        url: `${base()}/mcp`,
        mcpTools: ['buscar_cliente'],
        access: 'members',
        confirm: false,
      }),
      null,
    );
    const offered = await workerTools(deps(), kaiser.id, lkRoom);
    expect(offered).toEqual([
      {
        name: 'crm__buscar_cliente',
        description: 'CRM da empresa — Busca um cliente pelo e-mail',
        parameters: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] },
        confirm: false,
        access: 'members',
      },
    ]);

    const started = Date.now();
    expect(
      await run({
        tool: 'crm__buscar_cliente',
        args: { email: 'a@b.c' },
        requestedBy: [people.member.identity],
      }),
    ).toEqual({ ok: true, output: 'OK\nCliente a@b.c: plano Pro' });
    expect(Date.now() - started).toBeLessThan(4000); // did not wait for the stream to close
    await expectAppError(
      run({ tool: 'crm__apagar_tudo', args: {}, requestedBy: [people.admin.identity] }),
      404,
    );
    await expectAppError(
      run({ tool: 'crm__buscar_cliente', args: {}, requestedBy: [people.guest.identity] }),
      403,
    );
    const call = seen.find((s) => s.body.includes('tools/call'));
    expect(call?.headers['mcp-session-id']).toBe('sess-1');
    expect(call?.headers['mcp-protocol-version']).toBe('2025-06-18');

    // another organization's room, or a room without this agent, gets nothing
    await expectAppError(workerTools(deps(), kaiser.id, 'other-tenant.aula'), 404);
    expect(lk.calls).toEqual([]);
  });
});
