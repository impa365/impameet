import { z } from 'zod';
import { writerUser } from '@/server/guard';
import { clientIp, handle, json, readJson } from '@/server/http';
import { knowledgeDeps } from '@/server/knowledge/client';
import { deleteSource, reprocessSource, setSourceEnabled } from '@/server/knowledge/service';
import { knowledgeSourcePatch } from '@/server/validation';

export const dynamic = 'force-dynamic';

const id = z.string().uuid();
type Params = { params: Promise<{ id: string; sourceId: string }> };

export async function PATCH(req: Request, { params }: Params): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    const p = await params;
    const input = await readJson(req, knowledgeSourcePatch);
    const deps = knowledgeDeps();
    if (input.enabled !== undefined)
      await setSourceEnabled(deps, actor, id.parse(p.id), id.parse(p.sourceId), input.enabled);
    if (input.reprocess) void reprocessSource(deps, actor, id.parse(p.id), id.parse(p.sourceId));
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
