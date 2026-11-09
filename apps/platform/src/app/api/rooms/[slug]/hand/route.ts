import { config } from '@/server/config';
import { db } from '@/server/db';
import { notFound, tooManyRequests } from '@/server/errors';
import { assertSameOrigin, clientIp, handle, json, readJson } from '@/server/http';
import { limits } from '@/server/limits';
import { lk } from '@/server/livekit-client';
import { currentTenant } from '@/server/request';
import { setHand } from '@/server/rooms/hand';
import { findRoom } from '@/server/rooms/service';
import { handInput, roomSlug } from '@/server/validation';

export const dynamic = 'force-dynamic';

/** Raise or lower your hand; the join token proves who you are (guests have no session). */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(req);
    if (!limits.handPerIp.take(`hand:${clientIp(req)}`)) throw tooManyRequests();
    const ctx = await currentTenant();
    if (!ctx) throw notFound('Organização não encontrada');
    const room = await findRoom(db(), ctx.tenant.id, roomSlug.parse((await params).slug));
    if (!room) throw notFound('Sala não encontrada');
    const input = await readJson(req, handInput);
    return json(await setHand(config(), lk(), room, input.token, input.raised));
  });
}
