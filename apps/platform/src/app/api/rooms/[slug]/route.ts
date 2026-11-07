import { syncLiveAgents } from '@/server/agents/live';
import { config } from '@/server/config';
import { db } from '@/server/db';
import { lk } from '@/server/livekit-client';
import { tooManyRequests, unauthorized } from '@/server/errors';
import { assertSameOrigin, clientIp, handle, json, readJson } from '@/server/http';
import { limits } from '@/server/limits';
import { currentUser } from '@/server/request';
import { livekitRoomName } from '@/server/livekit';
import { AGENT_SETTINGS_TOPIC, POLICY_TOPIC, roomPolicies } from '@/server/rooms/join';
import { deleteRoom, updateRoom } from '@/server/rooms/service';
import { roomSlug, updateRoomInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

async function writer(req: Request) {
  assertSameOrigin(req);
  const user = await currentUser();
  if (!user) throw unauthorized();
  if (!limits.writePerUser.take(`write:${user.id}`)) throw tooManyRequests();
  return user;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  return handle(async () => {
    const user = await writer(req);
    const slug = roomSlug.parse((await params).slug);
    const patch = await readJson(req, updateRoomInput);
    const room = await updateRoom(db(), user, slug, patch, clientIp(req));
    let live = null;
    if (patch.agentEnabled !== undefined || patch.agentId !== undefined || patch.agentIds !== undefined) {
      // A failure here must not hide the saved change; the next meeting picks it up anyway.
      live = await syncLiveAgents(db(), lk(), config().agentName, room).catch(() => null);
    }
    if (patch.boardPolicy !== undefined || patch.pollsPolicy !== undefined) {
      void lk()
        .sendData(livekitRoomName(room.tenantId, room.slug), JSON.stringify(roomPolicies(room)), POLICY_TOPIC)
        .catch(() => undefined);
    }
    if (patch.thinkingSound !== undefined) {
      void lk()
        .sendData(
          livekitRoomName(room.tenantId, room.slug),
          JSON.stringify({ thinkingSound: room.thinkingSound }),
          AGENT_SETTINGS_TOPIC,
        )
        .catch(() => undefined);
    }
    return json({ room, live });
  });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  return handle(async () => {
    const user = await writer(req);
    await deleteRoom(db(), user, roomSlug.parse((await params).slug), clientIp(req));
    return json({ ok: true });
  });
}
