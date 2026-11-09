import { z } from 'zod';
import { config } from '@/server/config';
import { db } from '@/server/db';
import { handle, json, readJson } from '@/server/http';
import { internalAuthorized } from '@/server/internal';
import { lk } from '@/server/livekit-client';
import { agentModerate, agentModerationView } from '@/server/moderation/agent';
import { agentModerationInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

const agentId = z.string().uuid();
const roomName = z.string().min(3).max(200);
const hidden = () => json({ error: { code: 'not_found', message: 'Not found' } }, 404);

/** Who is in the agent's meeting and who is waiting to get in (X-Internal-Token required). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!internalAuthorized(req, config().internalToken)) return hidden();
  return handle(async () => {
    const id = agentId.parse((await params).id);
    const room = roomName.parse(new URL(req.url).searchParams.get('room'));
    return json(await agentModerationView(db(), lk(), id, room));
  });
}

/** An AI agent removes, mutes or answers the waiting room, within its admin's limits. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!internalAuthorized(req, config().internalToken)) return hidden();
  return handle(async () => {
    const id = agentId.parse((await params).id);
    const input = await readJson(req, agentModerationInput);
    return json(await agentModerate(db(), lk(), id, input));
  });
}
