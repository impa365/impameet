import { z } from 'zod';
import { config } from '@/server/config';
import { handle, json, readJson } from '@/server/http';
import { internalAuthorized } from '@/server/internal';
import { lk } from '@/server/livekit-client';
import { toolDeps } from '@/server/tools/client';
import { runAgentTool, workerTools } from '@/server/tools/service';
import { agentToolRunInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

const agentId = z.string().uuid();
const roomName = z.string().min(3).max(200);
const hidden = () => json({ error: { code: 'not_found', message: 'Not found' } }, 404);

/** The external tools the agent offers the model in this room (X-Internal-Token required). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!internalAuthorized(req, config().internalToken)) return hidden();
  return handle(async () => {
    const id = agentId.parse((await params).id);
    const room = roomName.parse(new URL(req.url).searchParams.get('room'));
    return json({ tools: await workerTools(toolDeps(), id, room) });
  });
}

/** Runs a tool the model called, for the people who asked (the platform checks they may). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!internalAuthorized(req, config().internalToken)) return hidden();
  return handle(async () => {
    const id = agentId.parse((await params).id);
    const input = await readJson(req, agentToolRunInput);
    return json(await runAgentTool(toolDeps(), lk(), id, input));
  });
}
