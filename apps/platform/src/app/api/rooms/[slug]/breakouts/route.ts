import {
  closeBreakouts,
  currentBreakouts,
  openBreakouts,
  openBreakoutsInput,
} from '@/server/breakouts/service';
import { db } from '@/server/db';
import { notFound } from '@/server/errors';
import { writerUser } from '@/server/guard';
import { clientIp, handle, json, readJson } from '@/server/http';
import { lk } from '@/server/livekit-client';
import { canModerate } from '@/server/moderation/service';
import { currentTenant, currentUser } from '@/server/request';
import { findRoom } from '@/server/rooms/service';
import { roomSlug } from '@/server/validation';

export const dynamic = 'force-dynamic';

async function loadRoom(params: Promise<{ slug: string }>) {
  const ctx = await currentTenant();
  if (!ctx) throw notFound('Organização não encontrada');
  const room = await findRoom(db(), ctx.tenant.id, roomSlug.parse((await params).slug));
  if (!room) throw notFound('Sala não encontrada');
  return room;
}

/** Open breakout rooms (anyone in the meeting may look; guests have no session). */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  return handle(async () => {
    const room = await loadRoom(params);
    const user = await currentUser();
    return json({
      session: await currentBreakouts(db(), room),
      canManage: user ? await canModerate(lk(), room, user) : false,
    });
  });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  return handle(async () => {
    const user = await writerUser(req);
    const room = await loadRoom(params);
    const input = await readJson(req, openBreakoutsInput);
    return json({ session: await openBreakouts(db(), lk(), room, user, input, clientIp(req)) }, 201);
  });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  return handle(async () => {
    const user = await writerUser(req);
    const room = await loadRoom(params);
    await closeBreakouts(db(), lk(), room, user, clientIp(req));
    return json({ ok: true });
  });
}
