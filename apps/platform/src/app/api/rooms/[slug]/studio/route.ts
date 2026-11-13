import { config } from '@/server/config';
import { db } from '@/server/db';
import { forbidden, notFound, tooManyRequests } from '@/server/errors';
import { assertSameOrigin, clientIp, handle, json, readJson } from '@/server/http';
import { limits } from '@/server/limits';
import { lk } from '@/server/livekit-client';
import { ROOM_TOKEN_HEADER, roomModerator, tokenVerifier } from '@/server/moderation/service';
import { currentTenant, currentUser } from '@/server/request';
import { findRoom } from '@/server/rooms/service';
import { saveStudio, studioState } from '@/server/studio/service';
import { roomSlug, studioStateInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

/** The producer: a moderator of the live studio (signed in, or promoted by their meeting token). */
async function producerOf(req: Request, params: Promise<{ slug: string }>) {
  const ctx = await currentTenant();
  if (!ctx) throw notFound('Organização não encontrada');
  const room = await findRoom(db(), ctx.tenant.id, roomSlug.parse((await params).slug));
  if (!room) throw notFound('Sala não encontrada');
  const cfg = config();
  const who = await roomModerator(lk(), room, await currentUser(), {
    token: req.headers.get(ROOM_TOKEN_HEADER),
    verify: tokenVerifier(cfg.livekitApiKey, cfg.livekitApiSecret),
  });
  return { room, who };
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  return handle(async () => {
    const { room, who } = await producerOf(req, params);
    if (!who) throw forbidden('Só quem produz o estúdio pode ver isso');
    return json({ studio: await studioState(db(), room) });
  });
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(req);
    const { room, who } = await producerOf(req, params);
    if (!limits.studioPerProducer.take(`studio:${who?.userId ?? who?.identity ?? clientIp(req)}`))
      throw tooManyRequests();
    const input = await readJson(req, studioStateInput, 64 * 1024);
    return json({ studio: await saveStudio(db(), lk(), room, who, input, clientIp(req)) });
  });
}
