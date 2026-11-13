import { config } from '@/server/config';
import { currentBreakouts } from '@/server/breakouts/service';
import { db } from '@/server/db';
import { forbidden, notFound, tooManyRequests } from '@/server/errors';
import { assertSameOrigin, clientIp, handle, json, readJson } from '@/server/http';
import { limits } from '@/server/limits';
import { lk } from '@/server/livekit-client';
import { livekitRoomName } from '@/server/livekit';
import {
  ROOM_TOKEN_HEADER,
  roomModerator,
  setMeetingControls,
  tokenVerifier,
} from '@/server/moderation/service';
import { currentTenant, currentUser } from '@/server/request';
import { AGENT_SETTINGS_TOPIC, POLICY_TOPIC, roomPolicies } from '@/server/rooms/join';
import { findRoom } from '@/server/rooms/service';
import { meetingControlsInput, roomSlug } from '@/server/validation';

export const dynamic = 'force-dynamic';

/** Any moderator of the live meeting, signed in or a promoted guest (by their LiveKit token). */
async function moderatorOf(req: Request, params: Promise<{ slug: string }>) {
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

/** The meeting's controls, for its moderators. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  return handle(async () => {
    const { room, who } = await moderatorOf(req, params);
    if (!who) return json({ canControl: false });
    return json({
      canControl: true,
      organizer: who.organizer,
      boardPolicy: room.boardPolicy,
      pollsPolicy: room.pollsPolicy,
      thinkingSound: room.thinkingSound,
      agentActions: room.agentActions,
    });
  });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(req);
    const { room, who } = await moderatorOf(req, params);
    if (!who) throw forbidden('Só moderadores podem fazer isso');
    if (!limits.writePerUser.take(`controls:${who.userId ?? who.identity}`)) throw tooManyRequests();
    const patch = await readJson(req, meetingControlsInput);
    const updated = await setMeetingControls(db(), room, who, patch, clientIp(req));
    const main = livekitRoomName(updated.tenantId, updated.slug);
    if (patch.boardPolicy !== undefined || patch.pollsPolicy !== undefined) {
      void lk()
        .sendData(main, JSON.stringify(roomPolicies(updated)), POLICY_TOPIC)
        .catch(() => undefined);
    }
    if (patch.thinkingSound !== undefined || patch.agentActions !== undefined) {
      const settings = { thinkingSound: updated.thinkingSound, agentActions: updated.agentActions };
      const breakouts = await currentBreakouts(db(), updated).catch(() => null);
      const rooms = [main, ...Array.from({ length: breakouts?.count ?? 0 }, (_, i) => `${main}~${i + 1}`)];
      for (const name of rooms)
        void lk()
          .sendData(name, JSON.stringify(settings), AGENT_SETTINGS_TOPIC)
          .catch(() => undefined);
    }
    return json({
      boardPolicy: updated.boardPolicy,
      pollsPolicy: updated.pollsPolicy,
      thinkingSound: updated.thinkingSound,
      agentActions: updated.agentActions,
    });
  });
}
