import { z } from 'zod';
import { config } from '@/server/config';
import { handle, json, readJson } from '@/server/http';
import { internalAuthorized } from '@/server/internal';
import { knowledgeDeps } from '@/server/knowledge/client';
import { agentSearch } from '@/server/knowledge/service';
import { agentKnowledgeInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

const agentId = z.string().uuid();
const hidden = () => json({ error: { code: 'not_found', message: 'Not found' } }, 404);

/** The agent looks something up in its knowledge bases during a meeting (X-Internal-Token). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!internalAuthorized(req, config().internalToken)) return hidden();
  return handle(async () => {
    const id = agentId.parse((await params).id);
    const { room, query, language } = await readJson(req, agentKnowledgeInput);
    return json({ hits: await agentSearch(knowledgeDeps(), id, room, query, language) });
  });
}
