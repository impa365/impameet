import { requireApiUser, auditV1 } from '@/server/api-v1/auth';
import { notFound } from '@/server/errors';
import { handle, json, readJson } from '@/server/http';
import { deleteRoom, findRoom, updateRoom } from '@/server/rooms/service';
import { updateRoomInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ slug: string }> };

export async function GET(req: Request, { params }: Params): Promise<Response> {
  return handle(async () => {
    const { slug } = await params;
    const ctx = await requireApiUser(req);
    const room = await findRoom(ctx.sql, ctx.user.tenantId, slug);
    if (!room) throw notFound('Sala não encontrada');
    const res = json({ room });
    auditV1(req, ctx, res.status);
    return res;
  });
}

export async function PATCH(req: Request, { params }: Params): Promise<Response> {
  return handle(async () => {
    const { slug } = await params;
    const ctx = await requireApiUser(req);
    const room = await updateRoom(ctx.sql, ctx.user, slug, await readJson(req, updateRoomInput), ctx.ip);
    const res = json({ room });
    auditV1(req, ctx, res.status);
    return res;
  });
}

export async function DELETE(req: Request, { params }: Params): Promise<Response> {
  return handle(async () => {
    const { slug } = await params;
    const ctx = await requireApiUser(req);
    await deleteRoom(ctx.sql, ctx.user, slug, ctx.ip);
    const res = json({ ok: true });
    auditV1(req, ctx, res.status);
    return res;
  });
}
