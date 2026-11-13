import { listAgentNames } from '@/server/agents/service';
import { db } from '@/server/db';
import { forbidden, notFound, tooManyRequests, unauthorized } from '@/server/errors';
import { assertSameOrigin, clientIp, handle, json, readJson } from '@/server/http';
import { limits } from '@/server/limits';
import { tenantLimits } from '@/server/plans';
import { currentTenant, currentUser } from '@/server/request';
import { findRoom, listInvites, managesRoom, setInvites } from '@/server/rooms/service';
import { roomInvitesInput, roomSlug } from '@/server/validation';

export const dynamic = 'force-dynamic';

async function managedRoom(params: Promise<{ slug: string }>) {
  const user = await currentUser();
  if (!user) throw unauthorized();
  const ctx = await currentTenant();
  if (!ctx) throw notFound('Organização não encontrada');
  const room = await findRoom(db(), ctx.tenant.id, roomSlug.parse((await params).slug));
  if (!room) throw notFound('Sala não encontrada');
  return { user, room, manages: managesRoom(room, user) };
}

/**
 * The organizer's controls for one room (access, invite list, AI agent, board and polls
 * permissions). Anyone else just learns they cannot manage it.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  return handle(async () => {
    const { room, manages } = await managedRoom(params);
    if (!manages) return json({ canManage: false });
    const [invites, agents, plan] = await Promise.all([
      listInvites(db(), room),
      listAgentNames(db(), room.tenantId),
      tenantLimits(db(), room.tenantId),
    ]);
    return json({
      canManage: true,
      access: room.access,
      allowGuests: room.allowGuests,
      boardPolicy: room.boardPolicy,
      pollsPolicy: room.pollsPolicy,
      thinkingSound: room.thinkingSound,
      agentActions: room.agentActions,
      studio: room.studio,
      invites,
      agentsAllowed: plan.agents,
      agentIds: room.agentIds,
      agents,
    });
  });
}

/** Replaces the room's invite list (people who enter a restricted room without asking). */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(req);
    const { user, room, manages } = await managedRoom(params);
    if (!manages) throw forbidden();
    if (!limits.writePerUser.take(`write:${user.id}`)) throw tooManyRequests();
    const { emails } = await readJson(req, roomInvitesInput, 32 * 1024);
    return json({ invites: await setInvites(db(), user, room, emails, clientIp(req)) });
  });
}
