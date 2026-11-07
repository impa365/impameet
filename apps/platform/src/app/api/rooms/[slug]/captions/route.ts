import { captionsOn, startCaptions, stopCaptions } from '@/server/captions/service';
import { config } from '@/server/config';
import { db } from '@/server/db';
import { notFound, unauthorized } from '@/server/errors';
import { writerUser } from '@/server/guard';
import { clientIp, handle, json } from '@/server/http';
import { lk } from '@/server/livekit-client';
import { canModerate } from '@/server/moderation/service';
import { tenantLimits } from '@/server/plans';
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

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  return handle(async () => {
    const user = await currentUser();
    if (!user) throw unauthorized();
    const room = await loadRoom(params);
    const allowed = (await tenantLimits(db(), room.tenantId)).agents;
    return json({
      canControl: allowed && (await canModerate(lk(), room, user)),
      on: await captionsOn(lk(), room),
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
    await startCaptions(db(), lk(), config().agentName, room, user, clientIp(req));
    return json({ ok: true }, 201);
  });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  return handle(async () => {
    const user = await writerUser(req);
    const room = await loadRoom(params);
    await stopCaptions(db(), lk(), room, user, clientIp(req));
    return json({ ok: true });
  });
}
