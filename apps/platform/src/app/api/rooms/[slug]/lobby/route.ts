import { db } from '@/server/db';
import { forbidden, notFound, tooManyRequests, unauthorized } from '@/server/errors';
import { assertSameOrigin, clientIp, handle, json, readJson } from '@/server/http';
import { limits } from '@/server/limits';
import { lk } from '@/server/livekit-client';
import { decide } from '@/server/lobby/service';
import { canModerate } from '@/server/moderation/service';
import { currentTenant, currentUser } from '@/server/request';
import { findRoom } from '@/server/rooms/service';
import { lobbyDecisionInput, roomSlug } from '@/server/validation';

export const dynamic = 'force-dynamic';

/** A moderator lets someone in from the waiting room, or turns them away. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(req);
    const user = await currentUser();
    if (!user) throw unauthorized();
    if (!limits.moderationPerUser.take(`mod:${user.id}`)) throw tooManyRequests();
    const ctx = await currentTenant();
    if (!ctx) throw notFound('Organização não encontrada');
    const room = await findRoom(db(), ctx.tenant.id, roomSlug.parse((await params).slug));
    if (!room) throw notFound('Sala não encontrada');
    if (!(await canModerate(lk(), room, user)))
      throw forbidden('Só moderadores podem responder a sala de espera');

    const { id, approve } = await readJson(req, lobbyDecisionInput);
    await decide(db(), room, user.id, id, approve, clientIp(req));
    return json({ ok: true });
  });
}
