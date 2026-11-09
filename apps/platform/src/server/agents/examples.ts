import type { z } from 'zod';
import { audit } from '../audit';
import type { SessionUser } from '../auth/session';
import type { Sql } from '../db';
import { badRequest, forbidden, notFound } from '../errors';
import type { agentExampleInput } from '../validation';

export type AgentExampleInput = z.infer<typeof agentExampleInput>;

export interface AgentExample {
  id: string;
  question: string;
  answer: string;
  enabled: boolean;
  createdAt: Date;
}

/** Enough to show the model the style and the facts that matter, without crowding it. */
export const MAX_EXAMPLES = 50;

function assertAdmin(user: SessionUser): void {
  if (user.role !== 'admin') throw forbidden('Só administradores configuram agentes de IA');
}

async function assertAgent(sql: Sql, tenantId: string, agentId: string) {
  const [row] = await sql`select 1 from agents where id = ${agentId} and tenant_id = ${tenantId}`;
  if (!row) throw notFound('Agente não encontrado');
}

const COLUMNS = (sql: Sql) => sql`id, question, answer, enabled, created_at as "createdAt"`;

export async function listExamples(sql: Sql, actor: SessionUser, agentId: string): Promise<AgentExample[]> {
  assertAdmin(actor);
  await assertAgent(sql, actor.tenantId, agentId);
  return sql<AgentExample[]>`
    select ${COLUMNS(sql)} from agent_examples where agent_id = ${agentId} order by created_at`;
}

export async function createExample(
  sql: Sql,
  actor: SessionUser,
  agentId: string,
  input: AgentExampleInput,
  ip: string | null,
): Promise<AgentExample> {
  assertAdmin(actor);
  await assertAgent(sql, actor.tenantId, agentId);
  const [{ count }] = await sql<{ count: number }[]>`
    select count(*)::int as count from agent_examples where agent_id = ${agentId}`;
  if (count >= MAX_EXAMPLES) throw badRequest(`Até ${MAX_EXAMPLES} exemplos por agente`);
  const [row] = await sql<AgentExample[]>`
    insert into agent_examples (tenant_id, agent_id, question, answer, enabled, created_by)
    values (${actor.tenantId}, ${agentId}, ${input.question}, ${input.answer}, ${input.enabled}, ${actor.id})
    returning ${COLUMNS(sql)}`;
  await audit(sql, {
    tenantId: actor.tenantId,
    actorId: actor.id,
    action: 'agent.example.created',
    target: agentId,
    ip,
  });
  return row;
}

export async function updateExample(
  sql: Sql,
  actor: SessionUser,
  agentId: string,
  id: string,
  input: AgentExampleInput,
): Promise<AgentExample> {
  assertAdmin(actor);
  const [row] = await sql<AgentExample[]>`
    update agent_examples set question = ${input.question}, answer = ${input.answer}, enabled = ${input.enabled}
    where id = ${id} and agent_id = ${agentId} and tenant_id = ${actor.tenantId}
    returning ${COLUMNS(sql)}`;
  if (!row) throw notFound('Exemplo não encontrado');
  return row;
}

export async function deleteExample(
  sql: Sql,
  actor: SessionUser,
  agentId: string,
  id: string,
  ip: string | null,
) {
  assertAdmin(actor);
  const [row] = await sql`
    delete from agent_examples where id = ${id} and agent_id = ${agentId} and tenant_id = ${actor.tenantId}
    returning id`;
  if (!row) throw notFound('Exemplo não encontrado');
  await audit(sql, {
    tenantId: actor.tenantId,
    actorId: actor.id,
    action: 'agent.example.deleted',
    target: agentId,
    ip,
  });
}
