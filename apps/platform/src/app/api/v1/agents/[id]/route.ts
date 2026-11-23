import { z } from 'zod';
import { MAX_AGENT_BYTES, deleteAgent, updateAgent } from '@/server/agents/service';
import { requireApiUser, auditV1 } from '@/server/api-v1/auth';
import { handle, json, readJson } from '@/server/http';
import { agentInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

const idSchema = z.string().uuid();
type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Params): Promise<Response> {
  return handle(async () => {
    const ctx = await requireApiUser(req);
    const agentId = idSchema.parse((await params).id);
    const agent = await updateAgent(
      ctx.sql,
      ctx.user,
      agentId,
      await readJson(req, agentInput, MAX_AGENT_BYTES),
      ctx.ip,
    );
    const res = json({ agent });
    auditV1(req, ctx, res.status);
    return res;
  });
}

export async function DELETE(req: Request, { params }: Params): Promise<Response> {
  return handle(async () => {
    const ctx = await requireApiUser(req);
    await deleteAgent(ctx.sql, ctx.user, idSchema.parse((await params).id), ctx.ip);
    const res = json({ ok: true });
    auditV1(req, ctx, res.status);
    return res;
  });
}
