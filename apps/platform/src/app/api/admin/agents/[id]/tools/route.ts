import { z } from 'zod';
import { db } from '@/server/db';
import { readerUser, writerUser } from '@/server/guard';
import { clientIp, handle, json, readJson } from '@/server/http';
import { toolDeps } from '@/server/tools/client';
import { createAgentTool, listAgentTools } from '@/server/tools/service';
import { agentToolInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

const id = z.string().uuid();
const MAX_TOOL_BYTES = 64 * 1024;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const actor = await readerUser();
    return json({ tools: await listAgentTools(db(), actor, id.parse((await params).id)) });
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    const agentId = id.parse((await params).id);
    const input = await readJson(req, agentToolInput, MAX_TOOL_BYTES);
    return json({ tool: await createAgentTool(toolDeps(), actor, agentId, input, clientIp(req)) }, 201);
  });
}
