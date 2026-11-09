import { z } from 'zod';
import { tooManyRequests } from '@/server/errors';
import { writerUser } from '@/server/guard';
import { handle, json, readJson } from '@/server/http';
import { limits } from '@/server/limits';
import { toolDeps } from '@/server/tools/client';
import { testAgentTool } from '@/server/tools/service';
import { agentToolTestInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

const id = z.string().uuid();

/** "Testar": runs an HTTP tool with sample arguments, or lists what an MCP server offers. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; toolId: string }> },
): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    if (!limits.moderationPerUser.take(`tool-test:${actor.id}`)) throw tooManyRequests();
    const p = await params;
    const input = await readJson(req, agentToolTestInput);
    return json(await testAgentTool(toolDeps(), actor, id.parse(p.id), id.parse(p.toolId), input.args));
  });
}
