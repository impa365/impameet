import { requireApiUser, auditV1 } from '@/server/api-v1/auth';
import { handle, json, readJson } from '@/server/http';
import { createRoom, listRooms } from '@/server/rooms/service';
import { createRoomInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return handle(async () => {
    const ctx = await requireApiUser(req);
    const res = json({ rooms: await listRooms(ctx.sql, ctx.user) });
    auditV1(req, ctx, res.status);
    return res;
  });
}

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const ctx = await requireApiUser(req);
    const room = await createRoom(ctx.sql, ctx.user, await readJson(req, createRoomInput), ctx.ip);
    const res = json({ room }, 201);
    auditV1(req, ctx, res.status);
    return res;
  });
}
