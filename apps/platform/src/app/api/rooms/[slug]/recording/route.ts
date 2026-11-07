import { db } from '@/server/db';
import { AppError, notFound, unauthorized } from '@/server/errors';
import { clientIp, handle, json } from '@/server/http';
import { writerUser } from '@/server/guard';
import { lk } from '@/server/livekit-client';
import { canModerate } from '@/server/moderation/service';
import { tenantLimits } from '@/server/plans';
import { recordingDeps } from '@/server/recordings/client';
import { activeRecording, startRecording, stopRecording } from '@/server/recordings/service';
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

function deps() {
  const d = recordingDeps();
  if (!d) throw new AppError(501, 'recording_disabled', 'A gravação não está instalada neste servidor');
  return d;
}

/** Whether the current user may record this room, and whether it is being recorded. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  return handle(async () => {
    const user = await currentUser();
    if (!user) throw unauthorized();
    const room = await loadRoom(params);
    const installed = recordingDeps() !== null;
    const allowed = installed && (await tenantLimits(db(), room.tenantId)).recording;
    return json({
      canRecord: allowed && (await canModerate(lk(), room, user)),
      active: allowed ? await activeRecording(db(), room) : null,
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
    return json({ recording: await startRecording(deps(), room, user, clientIp(req)) }, 201);
  });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  return handle(async () => {
    const user = await writerUser(req);
    const room = await loadRoom(params);
    await stopRecording(deps(), room, user, clientIp(req));
    return json({ ok: true });
  });
}
