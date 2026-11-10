import { z } from 'zod';
import { readerUser } from '@/server/guard';
import { handle, json } from '@/server/http';
import { knowledgeDeps } from '@/server/knowledge/client';
import { listChunks } from '@/server/knowledge/service';

export const dynamic = 'force-dynamic';

const id = z.string().uuid();
const offset = z.coerce.number().int().min(0).max(1_000_000).catch(0);

/** The pieces a source was cut into, 50 at a time (?offset=). */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; sourceId: string }> },
): Promise<Response> {
  return handle(async () => {
    const actor = await readerUser();
    const p = await params;
    const from = offset.parse(new URL(req.url).searchParams.get('offset') ?? 0);
    return json(await listChunks(knowledgeDeps(), actor, id.parse(p.id), id.parse(p.sourceId), from));
  });
}
