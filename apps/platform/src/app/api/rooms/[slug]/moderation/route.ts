import { config } from '@/server/config';
import { db } from '@/server/db';
import { notFound, tooManyRequests, unauthorized } from '@/server/errors';
import { assertSameOrigin, clientIp, handle, json, readJson } from '@/server/http';
import { limits } from '@/server/limits';
import { lk } from '@/server/livekit-client';
import { pendingRequests } from '@/server/lobby/service';
import {
  ROOM_TOKEN_HEADER,
  listLiveParticipants,
  moderate,
  tokenVerifier,
} from '@/server/moderation/service';
import { currentTenant, currentUser } from '@/server/request';
import { findRoom } from '@/server/rooms/service';
import { moderationInput, roomSlug } from '@/server/validation';

export const dynamic = 'force-dynamic';

async function loadRoom(params: Promise<{ slug: string }>) {
  const ctx = await currentTenant();
  if (!ctx) throw notFound('Organização não encontrada');
  const room = await findRoom(db(), ctx.tenant.id, roomSlug.parse((await params).slug));
  if (!room) throw notFound('Sala não encontrada');
  return room;
}

/** Signed-in people by their session; a promoted guest by the LiveKit token of the meeting. */
function credentials(req: Request) {
  const token = req.headers.get(ROOM_TOKEN_HEADER);
  const cfg = config();
  return { token, verify: tokenVerifier(cfg.livekitApiKey, cfg.livekitApiSecret) };
}

/** Live participants; moderators also get the waiting-room queue. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  return handle(async () => {
    const room = await loadRoom(params);
    const user = await currentUser();
    const creds = credentials(req);
    if (!user && !creds.token) throw unauthorized();
    const live = await listLiveParticipants(lk(), room, user, creds);
    return json({
      canModerate: live.canModerate,
      organizer: live.organizer,
      participants: live.participants.map(({ identity, name, role, isAgent, handRaised, audioMuted }) => ({
        identity,
        name,
        role,
        isAgent,
        handRaised,
        audioMuted,
      })),
      lobby: live.canModerate ? await pendingRequests(db(), room) : [],
    });
  });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(req);
    const user = await currentUser();
    const creds = credentials(req);
    if (!user && !creds.token) throw unauthorized();
    const key = user ? `mod:${user.id}` : `mod:${clientIp(req) ?? 'guest'}`;
    if (!limits.moderationPerUser.take(key)) throw tooManyRequests();
    const room = await loadRoom(params);
    const input = await readJson(req, moderationInput);
    return json(await moderate(db(), lk(), room, user, input.action, input.identity, clientIp(req), creds));
  });
}
