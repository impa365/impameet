import { z } from 'zod';
import { agentHealth } from '@/server/agents/health';
import { db } from '@/server/db';
import { readerUser } from '@/server/guard';
import { handle, json } from '@/server/http';

export const dynamic = 'force-dynamic';

const id = z.string().uuid();

/** Admin view: last reasons the agent stayed quiet or hit a pipeline error. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const actor = await readerUser();
    const agentId = id.parse((await params).id);
    return json({ health: await agentHealth(db(), actor.tenantId, agentId) });
  });
}
