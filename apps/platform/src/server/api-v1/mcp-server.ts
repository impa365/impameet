import 'server-only';
import { z } from 'zod';
import { createAgent, listAgents } from '../agents/service';
import {
  actorForOrg,
  findApiKeyOwner,
  listMembershipsByEmail,
  requireBearer,
  type ApiKeyOwner,
} from '../api-keys/service';
import type { SessionUser } from '../auth/session';
import { db } from '../db';
import { AppError, badRequest, unauthorized } from '../errors';
import { knowledgeDeps } from '../knowledge/client';
import { createBase, listBases } from '../knowledge/service';
import { createMeeting, listMeetings } from '../meetings/service';
import { createRoom, listRooms } from '../rooms/service';
import { createRoomInput, knowledgeBaseInput, meetingInput, agentInput } from '../validation';

interface RpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  needsOrg: boolean;
  run: (args: {
    owner: ApiKeyOwner;
    user: SessionUser | null;
    orgId: string | null;
    input: Record<string, unknown>;
  }) => Promise<unknown>;
}

const orgIdField = {
  type: 'string',
  description: 'UUID da organização (mesmo valor de X-Impa-Org)',
};

const TOOLS: ToolDef[] = [
  {
    name: 'list_orgs',
    description: 'Lista organizações em que o dono da chave é membro ativo',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    needsOrg: false,
    run: async ({ owner }) => ({
      orgs: await listMembershipsByEmail(db(), owner.email),
    }),
  },
  {
    name: 'list_rooms',
    description: 'Lista salas da organização',
    inputSchema: {
      type: 'object',
      properties: { orgId: orgIdField },
      required: ['orgId'],
      additionalProperties: false,
    },
    needsOrg: true,
    run: async ({ user }) => ({ rooms: await listRooms(db(), user!) }),
  },
  {
    name: 'create_room',
    description: 'Cria uma sala na organização',
    inputSchema: {
      type: 'object',
      properties: {
        orgId: orgIdField,
        name: { type: 'string' },
        slug: { type: 'string' },
        studio: { type: 'boolean' },
        allowGuests: { type: 'boolean' },
      },
      required: ['orgId', 'name'],
      additionalProperties: true,
    },
    needsOrg: true,
    run: async ({ user, input }) => {
      const { orgId: _o, ...body } = input;
      const room = await createRoom(db(), user!, createRoomInput.parse(body), null);
      return { room };
    },
  },
  {
    name: 'list_meetings',
    description: 'Lista reuniões agendadas visíveis para o usuário',
    inputSchema: {
      type: 'object',
      properties: { orgId: orgIdField },
      required: ['orgId'],
      additionalProperties: false,
    },
    needsOrg: true,
    run: async ({ user }) => ({ meetings: await listMeetings(db(), user!) }),
  },
  {
    name: 'schedule_meeting',
    description: 'Agenda uma reunião em uma sala existente',
    inputSchema: {
      type: 'object',
      properties: {
        orgId: orgIdField,
        roomSlug: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        startsAt: { type: 'string', description: 'ISO-8601 com offset' },
        durationMin: { type: 'integer' },
        invitees: { type: 'array', items: { type: 'string' } },
      },
      required: ['orgId', 'roomSlug', 'title', 'startsAt'],
      additionalProperties: false,
    },
    needsOrg: true,
    run: async ({ user, input }) => {
      const { orgId: _o, ...body } = input;
      const meeting = await createMeeting(db(), user!, meetingInput.parse(body), null);
      return { meeting };
    },
  },
  {
    name: 'list_agents',
    description: 'Lista agentes de IA da organização (requer agents.manage para criar)',
    inputSchema: {
      type: 'object',
      properties: { orgId: orgIdField },
      required: ['orgId'],
      additionalProperties: false,
    },
    needsOrg: true,
    run: async ({ user }) => ({ agents: await listAgents(db(), user!) }),
  },
  {
    name: 'create_agent',
    description: 'Cria um agente de IA (requer permissão agents.manage)',
    inputSchema: {
      type: 'object',
      properties: {
        orgId: orgIdField,
        name: { type: 'string' },
        instructions: { type: 'string' },
      },
      required: ['orgId', 'name'],
      additionalProperties: true,
    },
    needsOrg: true,
    run: async ({ user, input }) => {
      const { orgId: _o, ...body } = input;
      const agent = await createAgent(db(), user!, agentInput.parse(body), null);
      return { agent };
    },
  },
  {
    name: 'list_knowledge_bases',
    description: 'Lista bases de conhecimento (requer knowledge.manage)',
    inputSchema: {
      type: 'object',
      properties: { orgId: orgIdField },
      required: ['orgId'],
      additionalProperties: false,
    },
    needsOrg: true,
    run: async ({ user }) => {
      const deps = knowledgeDeps();
      return {
        enabled: deps.store !== null && deps.key !== null,
        bases: await listBases(db(), user!),
      };
    },
  },
  {
    name: 'create_knowledge_base',
    description: 'Cria uma base de conhecimento (requer knowledge.manage)',
    inputSchema: {
      type: 'object',
      properties: {
        orgId: orgIdField,
        name: { type: 'string' },
        description: { type: 'string' },
        embeddingIntegrationId: { type: 'string' },
        embeddingModel: { type: 'string' },
      },
      required: ['orgId', 'name', 'embeddingIntegrationId'],
      additionalProperties: false,
    },
    needsOrg: true,
    run: async ({ user, input }) => {
      const { orgId: _o, ...body } = input;
      const base = await createBase(knowledgeDeps(), user!, knowledgeBaseInput.parse(body), null);
      return { base };
    },
  },
];

function rpcResult(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: '2.0', id: id ?? null, result }, { status: 200 });
}

function rpcError(id: unknown, code: number, message: string, http = 200): Response {
  return Response.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, { status: http });
}

async function resolveUser(
  owner: ApiKeyOwner,
  input: Record<string, unknown>,
  headerOrg: string | null,
  needsOrg: boolean,
): Promise<{ user: SessionUser | null; orgId: string | null }> {
  const fromInput = typeof input.orgId === 'string' ? input.orgId.trim().toLowerCase() : '';
  const orgId = fromInput || headerOrg;
  if (needsOrg) {
    if (!orgId || !z.string().uuid().safeParse(orgId).success) {
      throw badRequest('Informe orgId (UUID da organização)');
    }
    return { user: await actorForOrg(db(), owner, orgId), orgId };
  }
  if (orgId && z.string().uuid().safeParse(orgId).success) {
    return { user: await actorForOrg(db(), owner, orgId), orgId };
  }
  return { user: null, orgId: null };
}

/** MCP Streamable HTTP (JSON-RPC) for ImpaMeet public tools. */
export async function handleMcpPost(req: Request): Promise<Response> {
  let body: RpcRequest;
  try {
    body = (await req.json()) as RpcRequest;
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return rpcError(body.id, -32600, 'Invalid Request', 400);
  }

  let owner: ApiKeyOwner;
  try {
    const found = await findApiKeyOwner(db(), requireBearer(req));
    if (!found) throw unauthorized('Chave de API inválida ou revogada');
    owner = found;
  } catch (err) {
    if (err instanceof AppError) return rpcError(body.id, -32001, err.message, err.status);
    return rpcError(body.id, -32001, 'Unauthorized', 401);
  }

  const headerOrg = (req.headers.get('x-impa-org') ?? '').trim().toLowerCase() || null;

  if (body.method === 'initialize') {
    return rpcResult(body.id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'impameet', version: '1.0.0' },
    });
  }
  if (body.method === 'notifications/initialized' || body.method === 'ping') {
    return rpcResult(body.id, {});
  }
  if (body.method === 'tools/list') {
    return rpcResult(body.id, {
      tools: TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
  }
  if (body.method === 'tools/call') {
    const name = typeof body.params?.name === 'string' ? body.params.name : '';
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return rpcError(body.id, -32601, `Unknown tool: ${name}`);
    const input =
      body.params?.arguments && typeof body.params.arguments === 'object'
        ? (body.params.arguments as Record<string, unknown>)
        : {};
    try {
      const { user, orgId } = await resolveUser(owner, input, headerOrg, tool.needsOrg);
      const result = await tool.run({ owner, user, orgId, input });
      return rpcResult(body.id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      });
    } catch (err) {
      if (err instanceof AppError) {
        return rpcResult(body.id, {
          content: [{ type: 'text', text: err.message }],
          isError: true,
        });
      }
      if (err && typeof err === 'object' && 'issues' in err) {
        return rpcResult(body.id, {
          content: [{ type: 'text', text: 'Parâmetros inválidos' }],
          isError: true,
        });
      }
      console.error('mcp tool error', err);
      return rpcResult(body.id, {
        content: [{ type: 'text', text: 'Erro inesperado' }],
        isError: true,
      });
    }
  }

  return rpcError(body.id, -32601, `Method not found: ${body.method}`);
}
