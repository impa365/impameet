import { z } from 'zod';
import { tooManyRequests } from '@/server/errors';
import { writerUser } from '@/server/guard';
import { handle, json, readJson } from '@/server/http';
import { limits } from '@/server/limits';
import { knowledgeDeps } from '@/server/knowledge/client';
import { testSearch } from '@/server/knowledge/service';
import { knowledgeSearchInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

const id = z.string().uuid();

/** "Testar a busca": what the agent would find for this question. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    if (!limits.moderationPerUser.take(`kb-search:${actor.id}`)) throw tooManyRequests();
    const { query } = await readJson(req, knowledgeSearchInput);
    return json({ hits: await testSearch(knowledgeDeps(), actor, id.parse((await params).id), query) });
  });
}
