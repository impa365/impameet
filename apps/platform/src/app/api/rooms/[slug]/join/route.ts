import { config } from '@/server/config';
import { db } from '@/server/db';
import { notFound, tooManyRequests } from '@/server/errors';
import { assertSameOrigin, clientIp, handle, json, readJson } from '@/server/http';
import { limits } from '@/server/limits';
import { livekitRoomName } from '@/server/livekit';
import { lk } from '@/server/livekit-client';
import { LOBBY_TOPIC, requestEntry } from '@/server/lobby/service';
import { currentTenant, currentUser } from '@/server/request';
import { grantJoin } from '@/server/rooms/join';
import { authorizeJoin, entersDirectly, findRoom } from '@/server/rooms/service';
import { joinInput, roomSlug } from '@/server/validation';

export const dynamic = 'force-dynamic';

/** 200 with a LiveKit token, or 202 with a waiting-room ticket when the room has a lobby. */
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

    const input = await readJson(req, joinInput);
    const user = await currentUser();
    const decision = await authorizeJoin(db(), room, user, input.password);
    const displayName = user?.name ?? input.displayName;

    if (!(await entersDirectly(db(), room, user, decision.role))) {
      const ticket = await requestEntry(db(), room, user, displayName);
      // Moderators in the call hear the knock at once instead of polling for it.
      void lk()
        .sendData(livekitRoomName(room.tenantId, room.slug), JSON.stringify({ type: 'knock' }), LOBBY_TOPIC)
        .catch(() => undefined);
      return json({ lobby: ticket }, 202);
    }
    return json(await grantJoin(db(), config(), room, { ...decision, displayName }));
  });
}
