import { z } from 'zod';
import { deleteExample, updateExample } from '@/server/agents/examples';
import { db } from '@/server/db';
import { writerUser } from '@/server/guard';
import { clientIp, handle, json, readJson } from '@/server/http';
import { agentExampleInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

const id = z.string().uuid();
type Params = { params: Promise<{ id: string; exampleId: string }> };

export async function PUT(req: Request, { params }: Params): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    const p = await params;
    const input = await readJson(req, agentExampleInput);
    return json({ example: await updateExample(db(), actor, id.parse(p.id), id.parse(p.exampleId), input) });
  });
}

export async function DELETE(req: Request, { params }: Params): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    const p = await params;
    await deleteExample(db(), actor, id.parse(p.id), id.parse(p.exampleId), clientIp(req));
    return json({ ok: true });
  });
}
