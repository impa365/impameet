import { z } from 'zod';
import { MAX_AGENT_BYTES, deleteAgent, updateAgent } from '@/server/agents/service';
import { db } from '@/server/db';
import { writerUser } from '@/server/guard';
import { clientIp, handle, json, readJson } from '@/server/http';
import { agentInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

const id = z.string().uuid();

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    const agentId = id.parse((await params).id);
    const input = await readJson(req, agentInput, MAX_AGENT_BYTES);
    return json({ agent: await updateAgent(db(), actor, agentId, input, clientIp(req)) });
  });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    await deleteAgent(db(), actor, id.parse((await params).id), clientIp(req));
    return json({ ok: true });
  });
}
