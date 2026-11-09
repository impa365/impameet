import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { audit } from '../audit';
import type { SessionUser } from '../auth/session';
import type { Sql } from '../db';
import { AppError, badRequest, conflict, forbidden, notFound, tooManyRequests } from '../errors';
import type { LiveKitAdmin } from '../livekit-admin';
import { agentInRoom, assertAgentActions, identityUserId } from '../moderation/agent';
import { RateLimiter } from '../security/rate-limit';
import { openSecret, sealSecret } from '../security/secrets';
import {
  MAX_TOOLS_PER_AGENT,
  type TOOL_ACCESS,
  type agentToolInput,
  type agentToolRunInput,
} from '../validation';
import {
  type HttpMethod,
  type ToolParam,
  assertHttpTemplate,
  coerceArgs,
  describeResponse,
  paramsSchema,
  renderHttp,
} from './http-tool';
import { type McpServer, type McpTool, callMcpTool, listMcpTools } from './mcp';
import { type NetPolicy, ToolNetworkError, assertToolUrl, outbound } from './net';

export type AgentToolInput = z.infer<typeof agentToolInput>;
export type AgentToolRunInput = z.infer<typeof agentToolRunInput>;
export type ToolAccess = (typeof TOOL_ACCESS)[number];

/** Everything that touches secrets or the network, injectable in tests. */
export interface ToolDeps {
  sql: Sql;
  key: Buffer;
  net: NetPolicy;
}

/** A tool as the admin panel sees it: header names, never their values. */
export interface AgentTool {
  id: string;
  agentId: string;
  kind: 'http' | 'mcp';
  name: string;
  description: string;
  enabled: boolean;
  access: ToolAccess;
  confirm: boolean;
  url: string;
  method: HttpMethod | null;
  params: ToolParam[];
  bodyTemplate: string | null;
  mcpTools: string[];
  timeoutMs: number;
  headerNames: string[];
  createdAt: Date;
  updatedAt: Date;
}

interface StoredTool extends AgentTool {
  tenantId: string;
  headersSealed: string | null;
}

/** What the voice worker registers with the model. */
export interface WorkerTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  confirm: boolean;
  access: ToolAccess;
}

const COLUMNS = (sql: Sql) => sql`
  id, tenant_id as "tenantId", agent_id as "agentId", kind, name, description, enabled, access,
  confirm, url, method, params, body_template as "bodyTemplate", mcp_tools as "mcpTools",
  timeout_ms as "timeoutMs", header_names as "headerNames", headers_sealed as "headersSealed",
  created_at as "createdAt", updated_at as "updatedAt"`;

const aad = (tenantId: string, id: string) => `agent-tool:${tenantId}:${id}`;

/** One agent calls external tools at most this often, per room. */
const runsPerRoom = new RateLimiter(30, 10 * 60_000);
const runsPerTool = new RateLimiter(10, 60_000);
const MAX_SCHEMA_CHARS = 8000;
const MCP_LIST_TTL_MS = 60_000;
const mcpListCache = new Map<string, { at: number; tools: McpTool[] }>();

function assertAdmin(user: SessionUser): void {
  if (user.role !== 'admin') throw forbidden('Só administradores configuram agentes de IA');
}

function publicView(t: StoredTool): AgentTool {
  const { tenantId: _t, headersSealed: _h, ...view } = t;
  return view;
}

/** Network problems are the admin's to fix (wrong URL, private address): report them as 400. */
function asAppError(err: unknown): never {
  if (err instanceof ToolNetworkError) throw badRequest(err.message);
  throw err;
}

async function assertAgent(sql: Sql, tenantId: string, agentId: string): Promise<void> {
  const [row] = await sql`select 1 from agents where id = ${agentId} and tenant_id = ${tenantId}`;
  if (!row) throw notFound('Agente não encontrado');
}

async function findStored(sql: Sql, tenantId: string, agentId: string, id: string): Promise<StoredTool> {
  const [row] = await sql<StoredTool[]>`
    select ${COLUMNS(sql)} from agent_tools
    where id = ${id} and agent_id = ${agentId} and tenant_id = ${tenantId}`;
  if (!row) throw notFound('Ferramenta não encontrada');
  return row;
}

function savedHeaders(deps: ToolDeps, t: Pick<StoredTool, 'tenantId' | 'id' | 'headersSealed'>) {
  if (!t.headersSealed) return {};
  return JSON.parse(openSecret(deps.key, t.headersSealed, aad(t.tenantId, t.id))) as Record<string, string>;
}

/** The new headers; an empty value keeps what was saved under that name. */
function mergeHeaders(
  current: Record<string, string>,
  input: AgentToolInput['headers'],
): Record<string, string> | null {
  if (input === null) return null;
  const byLower = new Map(Object.entries(current).map(([k, v]) => [k.toLowerCase(), v]));
  const out: Record<string, string> = {};
  for (const h of input) {
    const value = h.value || byLower.get(h.name.toLowerCase());
    if (!value) throw badRequest(`Informe o valor do cabeçalho ${h.name}`);
    out[h.name] = value;
  }
  return out;
}

async function checkInput(deps: ToolDeps, input: AgentToolInput): Promise<void> {
  if (input.kind === 'http') assertHttpTemplate(input);
  const sample = input.kind === 'http' ? input.url.replace(/\{\{[^}]*\}\}/g, 'x') : input.url;
  await assertToolUrl(sample, deps.net).catch(asAppError);
}

const isUniqueViolation = (err: unknown) => (err as { code?: string }).code === '23505';

export async function listAgentTools(sql: Sql, actor: SessionUser, agentId: string): Promise<AgentTool[]> {
  assertAdmin(actor);
  await assertAgent(sql, actor.tenantId, agentId);
  const rows = await sql<StoredTool[]>`
    select ${COLUMNS(sql)} from agent_tools
    where agent_id = ${agentId} and tenant_id = ${actor.tenantId} order by name`;
  return rows.map(publicView);
}

function columnsFor(input: AgentToolInput) {
  return {
    description: input.description,
    method: input.kind === 'http' ? input.method : null,
    params: input.kind === 'http' ? input.params : [],
    bodyTemplate: input.kind === 'http' ? input.bodyTemplate || null : null,
    mcpTools: input.kind === 'mcp' ? input.mcpTools : [],
  };
}

export async function createAgentTool(
  deps: ToolDeps,
  actor: SessionUser,
  agentId: string,
  input: AgentToolInput,
  ip: string | null,
): Promise<AgentTool> {
  assertAdmin(actor);
  const { sql } = deps;
  await assertAgent(sql, actor.tenantId, agentId);
  const [{ count }] = await sql<{ count: number }[]>`
    select count(*)::int as count from agent_tools where agent_id = ${agentId}`;
  if (count >= MAX_TOOLS_PER_AGENT) throw badRequest(`Até ${MAX_TOOLS_PER_AGENT} ferramentas por agente`);
  await checkInput(deps, input);
  const id = randomUUID();
  const headers = mergeHeaders({}, input.headers) ?? {};
  const sealed =
    Object.keys(headers).length > 0
      ? sealSecret(deps.key, JSON.stringify(headers), aad(actor.tenantId, id))
      : null;
  const c = columnsFor(input);
  try {
    await sql`
      insert into agent_tools (id, tenant_id, agent_id, kind, name, description, enabled, access, confirm,
                               url, method, params, body_template, mcp_tools, timeout_ms,
                               headers_sealed, header_names, created_by)
      values (${id}, ${actor.tenantId}, ${agentId}, ${input.kind}, ${input.name}, ${c.description},
              ${input.enabled}, ${input.access}, ${input.confirm}, ${input.url}, ${c.method},
              ${sql.json(c.params)}, ${c.bodyTemplate}, ${c.mcpTools}, ${input.timeoutMs},
              ${sealed}, ${Object.keys(headers)}, ${actor.id})`;
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('Este agente já tem uma ferramenta com esse nome');
    throw err;
  }
  await audit(sql, {
    tenantId: actor.tenantId,
    actorId: actor.id,
    action: 'agent.tool.created',
    target: input.name,
    meta: { kind: input.kind, access: input.access },
    ip,
  });
  return publicView(await findStored(sql, actor.tenantId, agentId, id));
}

export async function updateAgentTool(
  deps: ToolDeps,
  actor: SessionUser,
  agentId: string,
  id: string,
  input: AgentToolInput,
  ip: string | null,
): Promise<AgentTool> {
  assertAdmin(actor);
  const { sql } = deps;
  const current = await findStored(sql, actor.tenantId, agentId, id);
  if (current.kind !== input.kind) throw badRequest('Não é possível mudar o tipo da ferramenta');
  await checkInput(deps, input);
  const headers = mergeHeaders(savedHeaders(deps, current), input.headers);
  const sealed =
    headers === null
      ? current.headersSealed
      : Object.keys(headers).length > 0
        ? sealSecret(deps.key, JSON.stringify(headers), aad(actor.tenantId, id))
        : null;
  const names = headers === null ? current.headerNames : Object.keys(headers);
  const c = columnsFor(input);
  try {
    await sql`
      update agent_tools set name = ${input.name}, description = ${c.description},
        enabled = ${input.enabled}, access = ${input.access}, confirm = ${input.confirm},
        url = ${input.url}, method = ${c.method}, params = ${sql.json(c.params)},
        body_template = ${c.bodyTemplate}, mcp_tools = ${c.mcpTools}, timeout_ms = ${input.timeoutMs},
        headers_sealed = ${sealed}, header_names = ${names}, updated_at = now()
      where id = ${id} and agent_id = ${agentId} and tenant_id = ${actor.tenantId}`;
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('Este agente já tem uma ferramenta com esse nome');
    throw err;
  }
  mcpListCache.delete(id);
  await audit(sql, {
    tenantId: actor.tenantId,
    actorId: actor.id,
    action: 'agent.tool.updated',
    target: input.name,
    meta: { kind: input.kind, access: input.access, enabled: input.enabled },
    ip,
  });
  return publicView(await findStored(sql, actor.tenantId, agentId, id));
}

export async function deleteAgentTool(
  sql: Sql,
  actor: SessionUser,
  agentId: string,
  id: string,
  ip: string | null,
): Promise<void> {
  assertAdmin(actor);
  const [row] = await sql<{ name: string }[]>`
    delete from agent_tools where id = ${id} and agent_id = ${agentId} and tenant_id = ${actor.tenantId}
    returning name`;
  if (!row) throw notFound('Ferramenta não encontrada');
  mcpListCache.delete(id);
  await audit(sql, {
    tenantId: actor.tenantId,
    actorId: actor.id,
    action: 'agent.tool.deleted',
    target: row.name,
    ip,
  });
}

const mcpServer = (deps: ToolDeps, t: StoredTool): McpServer => ({
  url: t.url,
  headers: savedHeaders(deps, t),
  timeoutMs: t.timeoutMs,
});

async function serverTools(deps: ToolDeps, t: StoredTool, fresh = false): Promise<McpTool[]> {
  const cached = mcpListCache.get(t.id);
  if (!fresh && cached && Date.now() - cached.at < MCP_LIST_TTL_MS) return cached.tools;
  const tools = await listMcpTools(mcpServer(deps, t), deps.net, outbound);
  mcpListCache.set(t.id, { at: Date.now(), tools });
  return tools;
}

/** The name the model calls an MCP server's tool by: `<our tool>__<server tool>`. */
export function mcpToolName(tool: string, serverTool: string): string {
  return `${tool}__${serverTool}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

async function runHttp(deps: ToolDeps, t: StoredTool, raw: Record<string, unknown>) {
  const args = coerceArgs(t.params, raw);
  const req = renderHttp(
    {
      method: t.method!,
      url: t.url,
      params: t.params,
      bodyTemplate: t.bodyTemplate,
      headers: savedHeaders(deps, t),
    },
    args,
  );
  const res = await outbound({ ...req, timeoutMs: t.timeoutMs, maxBytes: 512 * 1024 }, deps.net);
  return { status: res.status, ...describeResponse(res) };
}

/** "Testar": HTTP tools run with sample arguments; MCP servers list what they offer. */
export async function testAgentTool(
  deps: ToolDeps,
  actor: SessionUser,
  agentId: string,
  id: string,
  args: Record<string, unknown>,
): Promise<{
  ok: boolean;
  output?: string;
  status?: number;
  tools?: { name: string; description: string }[];
}> {
  assertAdmin(actor);
  const t = await findStored(deps.sql, actor.tenantId, agentId, id);
  await audit(deps.sql, {
    tenantId: actor.tenantId,
    actorId: actor.id,
    action: 'agent.tool.tested',
    target: t.name,
  });
  try {
    if (t.kind === 'mcp') {
      const tools = await serverTools(deps, t, true);
      return { ok: true, tools: tools.map((x) => ({ name: x.name, description: x.description })) };
    }
    return await runHttp(deps, t, args);
  } catch (err) {
    if (err instanceof ToolNetworkError || err instanceof AppError) return { ok: false, output: err.message };
    throw err;
  }
}

function boundedSchema(schema: Record<string, unknown>): Record<string, unknown> | null {
  const { $schema: _s, ...rest } = schema;
  const out = { type: 'object', properties: {}, ...rest };
  return JSON.stringify(out).length <= MAX_SCHEMA_CHARS ? out : null;
}

/** The tools the agent offers the model in this room (MCP servers that fail are left out). */
export async function workerTools(deps: ToolDeps, agentId: string, lkRoom: string): Promise<WorkerTool[]> {
  const { agent } = await agentInRoom(deps.sql, agentId, lkRoom);
  const rows = await deps.sql<StoredTool[]>`
    select ${COLUMNS(deps.sql)} from agent_tools
    where agent_id = ${agent.id} and tenant_id = ${agent.tenantId} and enabled order by name`;
  const out: WorkerTool[] = [];
  for (const t of rows) {
    if (t.kind === 'http') {
      out.push({
        name: t.name,
        description: t.description,
        parameters: paramsSchema(t.params),
        confirm: t.confirm,
        access: t.access,
      });
      continue;
    }
    if (t.mcpTools.length === 0) continue;
    const offered = await serverTools(deps, t).catch(() => {
      console.warn('mcp server unavailable', { tool: t.name });
      return [] as McpTool[];
    });
    for (const s of offered) {
      if (!t.mcpTools.includes(s.name)) continue;
      const parameters = boundedSchema(s.inputSchema);
      if (!parameters) continue;
      out.push({
        name: mcpToolName(t.name, s.name),
        description: [t.description, s.description].filter(Boolean).join(' — ').slice(0, 1000),
        parameters,
        confirm: t.confirm,
        access: t.access,
      });
    }
  }
  return out;
}

/**
 * Everyone who spoke in the turn must be allowed. Guests never are, even when promoted to
 * moderator in the call: only signed-in, active members of this organization can ask, and for
 * "moderators" tools only the room owner, admins, managers or a member moderating this call.
 */
async function assertRequesters(
  sql: Sql,
  lk: LiveKitAdmin,
  lkRoom: string,
  room: { tenantId: string; ownerId: string | null },
  access: ToolAccess,
  identities: string[],
): Promise<{ actorId: string; names: string[] }> {
  const live = await lk.listParticipants(lkRoom);
  const names: string[] = [];
  let actorId: string | null = null;
  for (const identity of new Set(identities)) {
    const p = live.find((x) => x.identity === identity);
    if (!p || p.isAgent) throw forbidden('Quem pediu não está na reunião');
    const userId = identityUserId(identity);
    if (!userId) throw forbidden('Convidados não podem pedir para a IA usar ferramentas');
    const [user] = await sql<{ role: string }[]>`
      select role from users where id = ${userId} and tenant_id = ${room.tenantId} and status = 'active'`;
    if (!user) throw forbidden('Convidados não podem pedir para a IA usar ferramentas');
    const moderates =
      room.ownerId === userId || user.role === 'admin' || user.role === 'manager' || p.role === 'moderator';
    if (access === 'moderators' && !moderates)
      throw forbidden('Só moderadores da reunião podem pedir para a IA usar essa ferramenta');
    names.push(p.name);
    actorId ??= userId;
  }
  if (!actorId) throw forbidden('Quem pediu não está na reunião');
  return { actorId, names };
}

/** Runs a tool call the model made, for the people who asked, within every limit above. */
export async function runAgentTool(
  deps: ToolDeps,
  lk: LiveKitAdmin,
  agentId: string,
  input: AgentToolRunInput,
): Promise<{ ok: boolean; output: string }> {
  const { agent, room } = await agentInRoom(deps.sql, agentId, input.room);
  const rows = await deps.sql<StoredTool[]>`
    select ${COLUMNS(deps.sql)} from agent_tools
    where agent_id = ${agent.id} and tenant_id = ${agent.tenantId} and enabled`;
  let tool: StoredTool | undefined = rows.find((t) => t.kind === 'http' && t.name === input.tool);
  let serverTool: string | undefined;
  if (!tool) {
    for (const t of rows.filter((r) => r.kind === 'mcp')) {
      serverTool = t.mcpTools.find((s) => mcpToolName(t.name, s) === input.tool);
      if (serverTool) {
        tool = t;
        break;
      }
    }
  }
  if (!tool) throw notFound('Ferramenta não encontrada');
  assertAgentActions(room);

  const who = await assertRequesters(deps.sql, lk, input.room, room, tool.access, input.requestedBy);
  if (!runsPerRoom.take(`${agent.id}:${input.room}`) || !runsPerTool.take(`${tool.id}:${input.room}`))
    throw tooManyRequests();

  const started = Date.now();
  let result: { ok: boolean; output: string; status?: number };
  try {
    result =
      tool.kind === 'http'
        ? await runHttp(deps, tool, input.args)
        : await callMcpTool(mcpServer(deps, tool), deps.net, serverTool!, input.args, outbound);
  } catch (err) {
    if (!(err instanceof ToolNetworkError) && !(err instanceof AppError)) throw err;
    result = { ok: false, output: err.message };
  }
  await audit(deps.sql, {
    tenantId: room.tenantId,
    actorId: who.actorId,
    action: 'agent.tool',
    target: `${room.slug}:${input.tool}`,
    meta: {
      via: 'ai',
      agent: agent.name,
      requestedBy: who.names.join(', ').slice(0, 200),
      ok: result.ok,
      status: result.status ?? null,
      ms: Date.now() - started,
    },
  });
  return { ok: result.ok, output: result.output };
}
