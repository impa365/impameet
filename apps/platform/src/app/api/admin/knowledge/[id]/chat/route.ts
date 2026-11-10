import { z } from 'zod';
import { tooManyRequests } from '@/server/errors';
import { writerUser } from '@/server/guard';
import { handle, json, readJson } from '@/server/http';
import { limits } from '@/server/limits';
import { knowledgeDeps } from '@/server/knowledge/client';
import { chatTest } from '@/server/knowledge/service';
import { knowledgeChatInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

const id = z.string().uuid();

/** "Chat de teste": an answer written from the base by the model the admin picked, with sources. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    if (!limits.moderationPerUser.take(`kb-chat:${actor.id}`)) throw tooManyRequests();
    const input = await readJson(req, knowledgeChatInput);
    return json(await chatTest(knowledgeDeps(), actor, id.parse((await params).id), input));
  });
}
