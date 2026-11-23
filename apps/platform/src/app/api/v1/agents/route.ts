import { MAX_AGENT_BYTES, createAgent, listAgents } from '@/server/agents/service';
import { requireApiUser, auditV1 } from '@/server/api-v1/auth';
import { handle, json, readJson } from '@/server/http';
import { agentInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return handle(async () => {
    const ctx = await requireApiUser(req);
    const res = json({ agents: await listAgents(ctx.sql, ctx.user) });
    auditV1(req, ctx, res.status);
    return res;
  });
}

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const ctx = await requireApiUser(req);
    const agent = await createAgent(
      ctx.sql,
      ctx.user,
      await readJson(req, agentInput, MAX_AGENT_BYTES),
      ctx.ip,
    );
    const res = json({ agent }, 201);
    auditV1(req, ctx, res.status);
    return res;
  });
}
