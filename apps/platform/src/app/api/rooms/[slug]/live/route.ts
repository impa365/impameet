import { db } from '@/server/db';
import { notFound, unauthorized } from '@/server/errors';
import { writerUser } from '@/server/guard';
import { clientIp, handle, json, readJson } from '@/server/http';
import { liveDeps } from '@/server/live/client';
import { roomLive, startLive, stopLive } from '@/server/live/service';
import { currentTenant, currentUser } from '@/server/request';
import { findRoom } from '@/server/rooms/service';
import { liveStartInput, roomSlug } from '@/server/validation';

export const dynamic = 'force-dynamic';

async function loadRoom(params: Promise<{ slug: string }>) {
  const ctx = await currentTenant();
  if (!ctx) throw notFound('Organização não encontrada');
  const room = await findRoom(db(), ctx.tenant.id, roomSlug.parse((await params).slug));
  if (!room) throw notFound('Sala não encontrada');
  return room;
}

/** Whether the current user may take this room live, where to, and the live running now. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  return handle(async () => {
    const user = await currentUser();
    if (!user) throw unauthorized();
    return json(await roomLive(liveDeps(), await loadRoom(params), user));
  });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  return handle(async () => {
    const user = await writerUser(req);
    const room = await loadRoom(params);
    const input = await readJson(req, liveStartInput);
    return json({ live: await startLive(liveDeps(), room, user, input, clientIp(req)) }, 201);
  });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  return handle(async () => {
    const user = await writerUser(req);
    await stopLive(liveDeps(), await loadRoom(params), user, clientIp(req));
    return json({ ok: true });
  });
}
