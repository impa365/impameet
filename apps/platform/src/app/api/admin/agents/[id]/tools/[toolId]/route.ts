import { z } from 'zod';
import { db } from '@/server/db';
import { writerUser } from '@/server/guard';
import { clientIp, handle, json, readJson } from '@/server/http';
import { toolDeps } from '@/server/tools/client';
import { deleteAgentTool, updateAgentTool } from '@/server/tools/service';
import { agentToolInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

const id = z.string().uuid();
const MAX_TOOL_BYTES = 64 * 1024;
type Params = { params: Promise<{ id: string; toolId: string }> };

export async function PUT(req: Request, { params }: Params): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    const p = await params;
    const input = await readJson(req, agentToolInput, MAX_TOOL_BYTES);
    return json({
      tool: await updateAgentTool(
        toolDeps(),
        actor,
        id.parse(p.id),
        id.parse(p.toolId),
        input,
        clientIp(req),
      ),
    });
  });
}

export async function DELETE(req: Request, { params }: Params): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    const p = await params;
    await deleteAgentTool(db(), actor, id.parse(p.id), id.parse(p.toolId), clientIp(req));
    return json({ ok: true });
  });
}
