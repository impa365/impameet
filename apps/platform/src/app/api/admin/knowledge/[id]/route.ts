import { z } from 'zod';
import { db } from '@/server/db';
import { readerUser, writerUser } from '@/server/guard';
import { clientIp, handle, json, readJson } from '@/server/http';
import { knowledgeDeps } from '@/server/knowledge/client';
import { deleteBase, getBase, updateBase } from '@/server/knowledge/service';
import { knowledgeBaseSettings } from '@/server/validation';

export const dynamic = 'force-dynamic';

const id = z.string().uuid();
type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params): Promise<Response> {
  return handle(async () => {
    const actor = await readerUser();
    return json({ base: await getBase(db(), actor, id.parse((await params).id)) });
  });
}

/** Name, description and how the base cuts and searches (a new cut or model re-indexes it). */
export async function PATCH(req: Request, { params }: Params): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    const input = await readJson(req, knowledgeBaseSettings);
    const base = await updateBase(knowledgeDeps(), actor, id.parse((await params).id), input, clientIp(req));
    return json({ base });
  });
}

export async function DELETE(req: Request, { params }: Params): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    await deleteBase(knowledgeDeps(), actor, id.parse((await params).id), clientIp(req));
    return json({ ok: true });
  });
}
