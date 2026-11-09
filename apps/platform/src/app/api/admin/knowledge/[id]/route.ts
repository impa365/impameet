import { z } from 'zod';
import { db } from '@/server/db';
import { writerUser } from '@/server/guard';
import { clientIp, handle, json, readJson } from '@/server/http';
import { knowledgeDeps } from '@/server/knowledge/client';
import { deleteBase, renameBase } from '@/server/knowledge/service';
import { knowledgeRenameInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

const id = z.string().uuid();

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    const input = await readJson(req, knowledgeRenameInput);
    await renameBase(db(), actor, id.parse((await params).id), input);
    return json({ ok: true });
  });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    await deleteBase(knowledgeDeps(), actor, id.parse((await params).id), clientIp(req));
    return json({ ok: true });
  });
}
