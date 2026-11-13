import { config } from '@/server/config';
import { db } from '@/server/db';
import { forbidden, notFound, tooManyRequests, unauthorized } from '@/server/errors';
import { assertSameOrigin, clientIp, handle, json, readJson } from '@/server/http';
import { limits } from '@/server/limits';
import { lk } from '@/server/livekit-client';
import { decide } from '@/server/lobby/service';
import { ROOM_TOKEN_HEADER, roomModerator, tokenVerifier } from '@/server/moderation/service';
import { currentTenant, currentUser } from '@/server/request';
import { findRoom } from '@/server/rooms/service';
import { lobbyDecisionInput, roomSlug } from '@/server/validation';

export const dynamic = 'force-dynamic';

/** A moderator (signed in, or a promoted guest by their meeting token) answers the waiting room. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(req);
    const user = await currentUser();
    const token = req.headers.get(ROOM_TOKEN_HEADER);
    if (!user && !token) throw unauthorized();
    const key = user ? `mod:${user.id}` : `mod:${clientIp(req) ?? 'guest'}`;
    if (!limits.moderationPerUser.take(key)) throw tooManyRequests();
    const ctx = await currentTenant();
    if (!ctx) throw notFound('Organização não encontrada');
    const room = await findRoom(db(), ctx.tenant.id, roomSlug.parse((await params).slug));
    if (!room) throw notFound('Sala não encontrada');
    const cfg = config();
    const who = await roomModerator(lk(), room, user, {
      token,
      verify: tokenVerifier(cfg.livekitApiKey, cfg.livekitApiSecret),
    });
    if (!who) throw forbidden('Só moderadores podem responder a sala de espera');

    const { id, approve } = await readJson(req, lobbyDecisionInput);
    await decide(
      db(),
      room,
      who.userId,
      id,
      approve,
      clientIp(req),
      who.userId ? undefined : { by: who.name, identity: who.identity ?? '' },
    );
    return json({ ok: true });
  });
}
