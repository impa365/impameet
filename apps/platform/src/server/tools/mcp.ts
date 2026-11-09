import { MAX_TOOL_OUTPUT } from './http-tool';
import {
  type NetPolicy,
  type OutboundRequest,
  type OutboundResponse,
  ToolNetworkError,
  outbound,
} from './net';

/**
 * A minimal client for remote MCP servers over Streamable HTTP (JSON-RPC over POST; replies as
 * JSON or as a short event stream). Each use opens its own session and closes it afterwards.
 * Local (stdio) servers are not supported: they would run programs on this server.
 */

export interface McpServer {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

type Send = (req: OutboundRequest, policy: NetPolicy) => Promise<OutboundResponse>;

const PROTOCOL = '2025-06-18';
const MAX_REPLY_BYTES = 1024 * 1024;
const MAX_PAGES = 5;

interface RpcMessage {
  id?: unknown;
  result?: unknown;
  error?: { message?: unknown };
}

/** Complete events of a `text/event-stream` body, as parsed JSON messages. */
function streamedMessages(text: string): RpcMessage[] {
  const out: RpcMessage[] = [];
  const events = text.split(/\r?\n\r?\n/);
  events.pop(); // the last piece is still being written (or empty)
  for (const event of events) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) continue;
    try {
      const parsed: unknown = JSON.parse(data);
      out.push(...((Array.isArray(parsed) ? parsed : [parsed]) as RpcMessage[]));
    } catch {
      /* not JSON: ignore the event */
    }
  }
  return out;
}

function replyTo(res: OutboundResponse, id: number): RpcMessage {
  let messages: RpcMessage[];
  if ((res.headers['content-type'] ?? '').includes('text/event-stream')) {
    messages = streamedMessages(`${res.body}\n\n`);
  } else {
    try {
      const parsed: unknown = JSON.parse(res.body);
      messages = (Array.isArray(parsed) ? parsed : [parsed]) as RpcMessage[];
    } catch {
      throw new ToolNetworkError('O servidor MCP respondeu algo que não é JSON-RPC');
    }
  }
  const reply = messages.find((m) => m && m.id === id);
  if (!reply) throw new ToolNetworkError('O servidor MCP não respondeu ao pedido');
  if (reply.error) {
    const message = typeof reply.error.message === 'string' ? reply.error.message.slice(0, 300) : 'erro';
    throw new ToolNetworkError(`O servidor MCP recusou: ${message}`);
  }
  return reply;
}

export class McpSession {
  private sessionId: string | null = null;
  private protocol: string | null = null;
  private nextId = 1;

  constructor(
    private readonly server: McpServer,
    private readonly policy: NetPolicy,
    private readonly send: Send = outbound,
  ) {}

  private headers(): Record<string, string> {
    return {
      ...this.server.headers,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
      ...(this.protocol ? { 'mcp-protocol-version': this.protocol } : {}),
    };
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const res = await this.send(
      {
        url: this.server.url,
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        timeoutMs: this.server.timeoutMs,
        maxBytes: MAX_REPLY_BYTES,
        done: (text) => streamedMessages(text).some((m) => m && m.id === id),
      },
      this.policy,
    );
    if (res.status === 401 || res.status === 403)
      throw new ToolNetworkError('O servidor MCP recusou as credenciais');
    if (res.status < 200 || res.status >= 300)
      throw new ToolNetworkError(`O servidor MCP respondeu HTTP ${res.status}`);
    this.sessionId = res.headers['mcp-session-id'] ?? this.sessionId;
    return replyTo(res, id).result;
  }

  async open(): Promise<void> {
    const result = (await this.request('initialize', {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'impa-meet', version: '1' },
    })) as { protocolVersion?: unknown } | undefined;
    this.protocol = typeof result?.protocolVersion === 'string' ? result.protocolVersion : PROTOCOL;
    const res = await this.send(
      {
        url: this.server.url,
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        timeoutMs: this.server.timeoutMs,
        maxBytes: 4096,
      },
      this.policy,
    );
    if (res.status >= 400) throw new ToolNetworkError(`O servidor MCP respondeu HTTP ${res.status}`);
  }

  /** Ends the session on the server; failures do not matter (it expires anyway). */
  async close(): Promise<void> {
    if (!this.sessionId) return;
    await this.send(
      { url: this.server.url, method: 'DELETE', headers: this.headers(), timeoutMs: 3000, maxBytes: 4096 },
      this.policy,
    ).catch(() => undefined);
  }
}

async function withSession<T>(
  server: McpServer,
  policy: NetPolicy,
  send: Send,
  work: (s: McpSession) => Promise<T>,
): Promise<T> {
  const session = new McpSession(server, policy, send);
  try {
    await session.open();
    return await work(session);
  } finally {
    await session.close();
  }
}

export async function listMcpTools(
  server: McpServer,
  policy: NetPolicy,
  send: Send = outbound,
): Promise<McpTool[]> {
  return withSession(server, policy, send, async (session) => {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = (await session.request('tools/list', cursor ? { cursor } : {})) as {
        tools?: unknown;
        nextCursor?: unknown;
      };
      for (const t of Array.isArray(result?.tools) ? result.tools : []) {
        const tool = t as { name?: unknown; description?: unknown; inputSchema?: unknown };
        if (typeof tool.name !== 'string' || !tool.name) continue;
        const schema = tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : {};
        tools.push({
          name: tool.name.slice(0, 128),
          description: typeof tool.description === 'string' ? tool.description.slice(0, 1000) : '',
          inputSchema: schema as Record<string, unknown>,
        });
      }
      cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  });
}

/** The text of a tool result: text parts as they are, other parts named. */
function resultText(result: unknown): string {
  const r = (result ?? {}) as { content?: unknown; structuredContent?: unknown };
  const parts: string[] = [];
  for (const item of Array.isArray(r.content) ? r.content : []) {
    const c = item as { type?: unknown; text?: unknown; resource?: { text?: unknown; uri?: unknown } };
    if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    else if (c.type === 'resource' && typeof c.resource?.text === 'string') parts.push(c.resource.text);
    else if (c.type === 'resource_link' || c.type === 'resource')
      parts.push(`[recurso ${String(c.resource?.uri ?? '')}]`.trim());
    else if (typeof c.type === 'string') parts.push(`[${c.type}]`);
  }
  if (parts.length === 0 && r.structuredContent !== undefined)
    parts.push(JSON.stringify(r.structuredContent));
  return parts.join('\n').trim();
}

export async function callMcpTool(
  server: McpServer,
  policy: NetPolicy,
  name: string,
  args: Record<string, unknown>,
  send: Send = outbound,
): Promise<{ ok: boolean; output: string }> {
  return withSession(server, policy, send, async (session) => {
    const result = await session.request('tools/call', { name, arguments: args });
    const failed = Boolean((result as { isError?: unknown } | undefined)?.isError);
    const text = resultText(result) || '(sem conteúdo)';
    return { ok: !failed, output: `${failed ? 'ERRO' : 'OK'}\n${text}`.slice(0, MAX_TOOL_OUTPUT) };
  });
}
