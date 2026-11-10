import { z } from 'zod';
import { readerUser, writerUser } from '@/server/guard';
import { clientIp, handle, json, readJson } from '@/server/http';
import { knowledgeDeps } from '@/server/knowledge/client';
import { deleteSource, sourceDetail, updateSource } from '@/server/knowledge/service';
import { knowledgeSourceUpdate } from '@/server/validation';

export const dynamic = 'force-dynamic';

const id = z.string().uuid();
type Params = { params: Promise<{ id: string; sourceId: string }> };

/** One source with its pages (websites), activity and last indexing runs. */
export async function GET(_req: Request, { params }: Params): Promise<Response> {
  return handle(async () => {
    const actor = await readerUser();
    const p = await params;
    return json({ source: await sourceDetail(knowledgeDeps(), actor, id.parse(p.id), id.parse(p.sourceId)) });
  });
}

/** Title, text, Q&A pairs, re-sync, on/off or "index again". */
export async function PATCH(req: Request, { params }: Params): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    const p = await params;
    const input = await readJson(req, knowledgeSourceUpdate, 4 * 1024 * 1024);
    await updateSource(knowledgeDeps(), actor, id.parse(p.id), id.parse(p.sourceId), input);
    return json({ ok: true });
  });
}

export async function DELETE(req: Request, { params }: Params): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    const p = await params;
    await deleteSource(knowledgeDeps(), actor, id.parse(p.id), id.parse(p.sourceId), clientIp(req));
    return json({ ok: true });
  });
}
