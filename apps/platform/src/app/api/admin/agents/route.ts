import { MAX_AGENT_BYTES, createAgent, listAgents } from '@/server/agents/service';
import { db } from '@/server/db';
import { readerUser, writerUser } from '@/server/guard';
import { clientIp, handle, json, readJson } from '@/server/http';
import { agentInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return handle(async () => json({ agents: await listAgents(db(), await readerUser()) }));
}

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    const input = await readJson(req, agentInput, MAX_AGENT_BYTES);
    return json({ agent: await createAgent(db(), actor, input, clientIp(req)) }, 201);
  });
}
