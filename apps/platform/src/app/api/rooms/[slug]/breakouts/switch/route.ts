import { switchRoom, switchRoomInput } from '@/server/breakouts/service';
import { config } from '@/server/config';
import { db } from '@/server/db';
import { notFound, tooManyRequests } from '@/server/errors';
import { assertSameOrigin, clientIp, handle, json, readJson } from '@/server/http';
import { limits } from '@/server/limits';
import { currentTenant } from '@/server/request';
import { findRoom } from '@/server/rooms/service';
import { roomSlug } from '@/server/validation';

export const dynamic = 'force-dynamic';

/** Trades the caller's current meeting token for one to another room of the same meeting. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(req);
    if (!limits.joinPerIp.take(`join:${clientIp(req)}`)) throw tooManyRequests();
    const ctx = await currentTenant();
    if (!ctx) throw notFound('Organização não encontrada');
    const room = await findRoom(db(), ctx.tenant.id, roomSlug.parse((await params).slug));
    if (!room) throw notFound('Sala não encontrada');
    const input = await readJson(req, switchRoomInput);
    return json(await switchRoom(db(), config(), room, input));
  });
}
