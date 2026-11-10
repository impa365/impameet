import { z } from 'zod';
import { db } from '@/server/db';
import { readerUser } from '@/server/guard';
import { handle, json } from '@/server/http';
import { knowledgeMetrics } from '@/server/knowledge/service';

export const dynamic = 'force-dynamic';

const id = z.string().uuid();
const days = z.coerce.number().int().min(1).max(30).catch(7);

/** How the base is being used: searches per day, questions with no answer, most found pieces. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const actor = await readerUser();
    const period = days.parse(new URL(req.url).searchParams.get('days') ?? 7);
    return json({ metrics: await knowledgeMetrics(db(), actor, id.parse((await params).id), period) });
  });
}
