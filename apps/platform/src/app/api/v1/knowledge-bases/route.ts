import { requireApiUser, auditV1 } from '@/server/api-v1/auth';
import { db } from '@/server/db';
import { handle, json, readJson } from '@/server/http';
import { knowledgeDeps } from '@/server/knowledge/client';
import { createBase, listBases } from '@/server/knowledge/service';
import { knowledgeBaseInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return handle(async () => {
    const ctx = await requireApiUser(req);
    const deps = knowledgeDeps();
    const res = json({
      enabled: deps.store !== null && deps.key !== null,
      bases: await listBases(db(), ctx.user),
    });
    auditV1(req, ctx, res.status);
    return res;
  });
}

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const ctx = await requireApiUser(req);
    const base = await createBase(knowledgeDeps(), ctx.user, await readJson(req, knowledgeBaseInput), ctx.ip);
    const res = json({ base }, 201);
    auditV1(req, ctx, res.status);
    return res;
  });
}
