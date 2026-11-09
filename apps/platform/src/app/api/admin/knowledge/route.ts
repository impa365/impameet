import { db } from '@/server/db';
import { readerUser, writerUser } from '@/server/guard';
import { clientIp, handle, json, readJson } from '@/server/http';
import { knowledgeDeps } from '@/server/knowledge/client';
import { createBase, listBases } from '@/server/knowledge/service';
import { knowledgeBaseInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return handle(async () => {
    const deps = knowledgeDeps();
    return json({
      enabled: deps.store !== null && deps.key !== null,
      bases: await listBases(db(), await readerUser()),
    });
  });
}

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    const input = await readJson(req, knowledgeBaseInput);
    return json({ base: await createBase(knowledgeDeps(), actor, input, clientIp(req)) }, 201);
  });
}
