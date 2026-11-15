import type { Sql } from '../db';
import { notFound } from '../errors';

export const AGENT_EVENT_KINDS = [
  'joined',
  'left',
  'rejected',
  'pipeline_error',
  'skipped_reply',
  'muted',
  'unmuted',
  'answered',
] as const;
export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number];

export interface AgentSessionEvent {
  id: string;
  roomName: string;
  sessionId: string | null;
  at: string;
  kind: AgentEventKind;
  code: string;
  source: string | null;
  detail: string | null;
}

export interface AgentHealthSummary {
  /** Latest non-answered signal that explains silence or failure. */
  status: 'ok' | 'silent' | 'error' | 'unknown';
  lastCode: string | null;
  lastKind: AgentEventKind | null;
  lastAt: string | null;
  lastRoom: string | null;
  lastSource: string | null;
  lastDetail: string | null;
  recent: AgentSessionEvent[];
}

type EventRow = {
  id: string;
  room_name: string;
  session_id: string | null;
  at: Date | string;
  kind: AgentEventKind;
  code: string;
  source: string | null;
  detail: string | null;
};

function mapEvent(row: EventRow): AgentSessionEvent {
  return {
    id: row.id,
    roomName: row.room_name,
    sessionId: row.session_id,
    at: row.at instanceof Date ? row.at.toISOString() : String(row.at),
    kind: row.kind,
    code: row.code,
    source: row.source,
    detail: row.detail,
  };
}

/** Keep at most two weeks of health rows. */
export async function pruneAgentEvents(sql: Sql): Promise<void> {
  await sql`delete from agent_session_events where at < now() - interval '14 days'`;
}

export async function recordAgentEvent(
  sql: Sql,
  agentId: string,
  input: {
    roomName: string;
    sessionId?: string | null;
    kind: AgentEventKind;
    code: string;
    source?: string | null;
    detail?: string | null;
  },
): Promise<AgentSessionEvent> {
  const [agent] = await sql<{ tenantId: string }[]>`
    select tenant_id as "tenantId" from agents where id = ${agentId}`;
  if (!agent) throw notFound('Agente não encontrado');

  const [row] = await sql<EventRow[]>`
    insert into agent_session_events (
      tenant_id, agent_id, room_name, session_id, kind, code, source, detail
    ) values (
      ${agent.tenantId},
      ${agentId},
      ${input.roomName.slice(0, 200)},
      ${input.sessionId?.slice(0, 120) ?? null},
      ${input.kind},
      ${input.code.slice(0, 40)},
      ${input.source?.slice(0, 40) ?? null},
      ${input.detail?.slice(0, 200) ?? null}
    )
    returning id, room_name, session_id, at, kind, code, source, detail`;

  if (Math.random() < 0.02) await pruneAgentEvents(sql).catch(() => undefined);

  return mapEvent(row);
}

export async function listAgentEvents(
  sql: Sql,
  tenantId: string,
  agentId: string,
  limit = 40,
): Promise<AgentSessionEvent[]> {
  const [owns] = await sql<{ ok: boolean }[]>`
    select true as ok from agents where id = ${agentId} and tenant_id = ${tenantId}`;
  if (!owns) throw notFound('Agente não encontrado');

  const rows = await sql<EventRow[]>`
    select id, room_name, session_id, at, kind, code, source, detail
    from agent_session_events
    where agent_id = ${agentId} and tenant_id = ${tenantId}
    order by at desc
    limit ${Math.min(100, Math.max(1, limit))}`;
  return rows.map(mapEvent);
}

function summarize(events: AgentSessionEvent[]): AgentHealthSummary {
  const diagnostic = events.find((e) =>
    ['pipeline_error', 'skipped_reply', 'muted', 'rejected'].includes(e.kind),
  );
  const joined = events.find((e) => e.kind === 'joined');
  if (!diagnostic && !joined && events.length === 0) {
    return {
      status: 'unknown',
      lastCode: null,
      lastKind: null,
      lastAt: null,
      lastRoom: null,
      lastSource: null,
      lastDetail: null,
      recent: [],
    };
  }
  if (diagnostic?.kind === 'pipeline_error' || diagnostic?.kind === 'rejected') {
    return {
      status: 'error',
      lastCode: diagnostic.code,
      lastKind: diagnostic.kind,
      lastAt: diagnostic.at,
      lastRoom: diagnostic.roomName,
      lastSource: diagnostic.source,
      lastDetail: diagnostic.detail,
      recent: events,
    };
  }
  if (diagnostic && (diagnostic.kind === 'skipped_reply' || diagnostic.kind === 'muted')) {
    return {
      status: 'silent',
      lastCode: diagnostic.code,
      lastKind: diagnostic.kind,
      lastAt: diagnostic.at,
      lastRoom: diagnostic.roomName,
      lastSource: diagnostic.source,
      lastDetail: diagnostic.detail,
      recent: events,
    };
  }
  const last = events[0] ?? null;
  return {
    status: 'ok',
    lastCode: last?.code ?? 'ok',
    lastKind: last?.kind ?? null,
    lastAt: last?.at ?? null,
    lastRoom: last?.roomName ?? null,
    lastSource: last?.source ?? null,
    lastDetail: last?.detail ?? null,
    recent: events,
  };
}

export async function agentHealth(sql: Sql, tenantId: string, agentId: string): Promise<AgentHealthSummary> {
  const recent = await listAgentEvents(sql, tenantId, agentId, 40);
  return summarize(recent);
}
