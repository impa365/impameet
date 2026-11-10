import { z } from 'zod';
import { tooManyRequests } from '@/server/errors';
import { writerUser } from '@/server/guard';
import { handle, json, readJson } from '@/server/http';
import { limits } from '@/server/limits';
import { knowledgeDeps } from '@/server/knowledge/client';
import { previewWebsite } from '@/server/knowledge/service';
import { knowledgeCrawlInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

const id = z.string().uuid();

/** The pages of a website (sitemap, then links), to choose before importing. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    if (!limits.moderationPerUser.take(`kb-crawl:${actor.id}`)) throw tooManyRequests();
    const input = await readJson(req, knowledgeCrawlInput);
    return json({ pages: await previewWebsite(knowledgeDeps(), actor, id.parse((await params).id), input) });
  });
}
