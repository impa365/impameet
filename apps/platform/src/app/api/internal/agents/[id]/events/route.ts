import { z } from 'zod';
import { recordAgentEvent } from '@/server/agents/health';
import { config } from '@/server/config';
import { db } from '@/server/db';
import { handle, json, readJson } from '@/server/http';
import { internalAuthorized } from '@/server/internal';
import { agentHealthEventInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

const agentId = z.string().uuid();
const hidden = () => json({ error: { code: 'not_found', message: 'Not found' } }, 404);

/** The voice agent reports why it stayed quiet or failed (short codes only). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!internalAuthorized(req, config().internalToken)) return hidden();
  return handle(async () => {
    const id = agentId.parse((await params).id);
    const input = await readJson(req, agentHealthEventInput);
    const event = await recordAgentEvent(db(), id, {
      roomName: input.room,
      sessionId: input.sessionId,
      kind: input.kind,
      code: input.code,
      source: input.source,
      detail: input.detail,
    });
    return json({ event }, 201);
  });
}
