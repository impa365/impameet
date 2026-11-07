import { randomBytes } from 'node:crypto';
import { config } from '@/server/config';
import { db } from '@/server/db';
import { notFound, tooManyRequests } from '@/server/errors';
import { assertSameOrigin, clientIp, handle, json, readJson } from '@/server/http';
import { limits } from '@/server/limits';
import { entryStatus } from '@/server/lobby/service';
import { currentTenant } from '@/server/request';
import { grantJoin } from '@/server/rooms/join';
import { findRoom } from '@/server/rooms/service';
import { lobbyStatusInput, roomSlug } from '@/server/validation';

export const dynamic = 'force-dynamic';

/** Polled by someone in the waiting room; returns the token once a moderator lets them in. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(req);
    if (!limits.lobbyPollPerIp.take(`lobby:${clientIp(req)}`)) throw tooManyRequests();
    const ctx = await currentTenant();
    if (!ctx) throw notFound('Organização não encontrada');
    const room = await findRoom(db(), ctx.tenant.id, roomSlug.parse((await params).slug));
    if (!room) throw notFound('Sala não encontrada');

    const { id, secret } = await readJson(req, lobbyStatusInput);
    const entry = await entryStatus(db(), room, id, secret);
    if (entry.status !== 'approved') return json({ status: entry.status });

    const identity = entry.userId
      ? `u-${entry.userId}-${randomBytes(3).toString('hex')}`
      : `g-${randomBytes(6).toString('hex')}`;
    const grant = await grantJoin(db(), config(), room, {
      identity,
      displayName: entry.displayName,
      role: entry.userId ? 'participant' : 'guest',
    });
    return json({ status: 'approved', ...grant });
  });
}
