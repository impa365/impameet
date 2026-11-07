import { db } from '@/server/db';
import { tooManyRequests, unauthorized } from '@/server/errors';
import { assertSameOrigin, clientIp, handle, json, readJson } from '@/server/http';
import { limits } from '@/server/limits';
import { currentUser } from '@/server/request';
import { createRoom, listRooms } from '@/server/rooms/service';
import { createRoomInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return handle(async () => {
    const user = await currentUser();
    if (!user) throw unauthorized();
    return json({ rooms: await listRooms(db(), user) });
  });
}

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(req);
    const user = await currentUser();
    if (!user) throw unauthorized();
    if (!limits.writePerUser.take(`write:${user.id}`)) throw tooManyRequests();
    const room = await createRoom(db(), user, await readJson(req, createRoomInput), clientIp(req));
    return json({ room }, 201);
  });
}
