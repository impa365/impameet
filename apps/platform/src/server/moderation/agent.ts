import type { z } from 'zod';
import { audit } from '../audit';
import type { Sql } from '../db';
import { badRequest, forbidden, notFound, tooManyRequests } from '../errors';
import type { LiveKitAdmin, LiveParticipant } from '../livekit-admin';
import { decide, pendingRequests } from '../lobby/service';
import { RateLimiter } from '../security/rate-limit';
import { type Room, findRoom } from '../rooms/service';
import type { agentModerationInput } from '../validation';

export type AgentModerationInput = z.infer<typeof agentModerationInput>;

/** An AI agent never acts on more than this many people in ten minutes, in one room. */
const agentActions = new RateLimiter(10, 10 * 60_000);

const TOOL_FOR = { remove: 'remove', mute: 'mute', admit: 'lobby', deny: 'lobby' } as const;
const USER_IDENTITY = /^u-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-/;

interface ModeratingAgent {
  id: string;
  tenantId: string;
  name: string;
  moderationTools: string[];
  moderationRules: string;
}

export interface AgentModerationView {
  people: { identity: string; name: string; role: string; micOn: boolean; protected: boolean }[];
  lobby: { id: string; name: string }[];
}

/** The user behind a signed-in participant identity (`u-<user id>-…`). */
export function identityUserId(identity: string): string | null {
  return USER_IDENTITY.exec(identity)?.[1] ?? null;
}

/** The agent and the room it sits in. The LiveKit room must be one of its organization's rooms. */
async function agentInRoom(
  sql: Sql,
  agentId: string,
  lkRoom: string,
): Promise<{ agent: ModeratingAgent; room: Room }> {
  const [agent] = await sql<(ModeratingAgent & { tenantStatus: string })[]>`
    select a.id, a.tenant_id as "tenantId", a.name, a.moderation_tools as "moderationTools",
           a.moderation_rules as "moderationRules", t.status as "tenantStatus"
    from agents a join tenants t on t.id = a.tenant_id where a.id = ${agentId}`;
  if (!agent || agent.tenantStatus !== 'active') throw notFound('Agente não encontrado');
  const [tenantId, rest] = [lkRoom.slice(0, lkRoom.indexOf('.')), lkRoom.slice(lkRoom.indexOf('.') + 1)];
  const slug = rest.split('~')[0];
  if (tenantId !== agent.tenantId || !slug) throw notFound('Sala não encontrada');
  const room = await findRoom(sql, agent.tenantId, slug);
  if (!room || !room.agentIds.includes(agent.id)) throw notFound('Sala não encontrada');
  return { agent, room };
}

/**
 * People the agent must never act on: other assistants, moderators, the room owner and the
 * organization's admins and managers.
 */
async function protectedIdentities(sql: Sql, room: Room, people: LiveParticipant[]): Promise<Set<string>> {
  const ids = new Set<string>();
  const userIds = new Map<string, string>();
  for (const p of people) {
    if (p.isAgent || p.role === 'moderator') ids.add(p.identity);
    const uid = identityUserId(p.identity);
    if (uid) userIds.set(uid, p.identity);
  }
  if (userIds.size > 0) {
    const staff = await sql<{ id: string }[]>`
      select id from users
      where tenant_id = ${room.tenantId} and id in ${sql([...userIds.keys()])}
        and (role in ('admin', 'manager') or id = ${room.ownerId ?? null})`;
    for (const { id } of staff) ids.add(userIds.get(id)!);
  }
  return ids;
}

/** What the agent sees before acting: who is in the call and who is waiting to get in. */
export async function agentModerationView(
  sql: Sql,
  lk: LiveKitAdmin,
  agentId: string,
  lkRoom: string,
): Promise<AgentModerationView> {
  const { room } = await agentInRoom(sql, agentId, lkRoom);
  const people = await lk.listParticipants(lkRoom);
  const shielded = await protectedIdentities(sql, room, people);
  return {
    people: people
      .filter((p) => !p.isAgent)
      .map((p) => ({
        identity: p.identity,
        name: p.name,
        role: p.role,
        micOn: !p.audioMuted,
        protected: shielded.has(p.identity),
      })),
    lobby: (await pendingRequests(sql, room)).map((r) => ({ id: r.id, name: r.displayName })),
  };
}

/**
 * Carries out what the agent decided. Allowed only for the tools an admin turned on, when a
 * moderator in the call asked for it or an admin rule applies, and never against protected
 * people. Every action is in the audit log.
 */
export async function agentModerate(
  sql: Sql,
  lk: LiveKitAdmin,
  agentId: string,
  input: AgentModerationInput,
): Promise<{ done: string }> {
  const { agent, room } = await agentInRoom(sql, agentId, input.room);
  if (!agent.moderationTools.includes(TOOL_FOR[input.action]))
    throw forbidden('Este agente não tem permissão para essa ação');

  const people = await lk.listParticipants(input.room);
  const shielded = await protectedIdentities(sql, room, people);
  const requester = input.requestedBy ? people.find((p) => p.identity === input.requestedBy) : undefined;
  const byModerator = requester !== undefined && shielded.has(requester.identity) && !requester.isAgent;
  const byRule = !byModerator && agent.moderationRules.trim() !== '' && (input.rule ?? '').trim() !== '';
  if (!byModerator && !byRule)
    throw forbidden('Só um moderador da reunião ou uma regra definida pelo administrador autoriza isso');
  if (!agentActions.take(`${agent.id}:${input.room}`)) throw tooManyRequests();

  const meta = {
    via: 'ai',
    agent: agent.name,
    requestedBy: requester?.name ?? '',
    rule: byRule ? (input.rule ?? '').slice(0, 200) : '',
  };
  const actorId = byModerator ? identityUserId(requester.identity) : null;

  if (input.action === 'admit' || input.action === 'deny') {
    const waiting = await pendingRequests(sql, room);
    const request = waiting.find((r) => r.id === input.target);
    if (!request) throw notFound('Ninguém com esse pedido na sala de espera');
    await decide(sql, room, actorId, request.id, input.action === 'admit', null, meta);
    return { done: `${request.displayName} ${input.action === 'admit' ? 'entrou' : 'foi recusado'}` };
  }

  const target = people.find((p) => p.identity === input.target);
  if (!target) throw notFound('Participante não está na sala');
  if (shielded.has(target.identity))
    throw forbidden('A IA não age sobre moderadores, o dono da sala, administradores ou outros assistentes');
  if (target.identity === requester?.identity) throw badRequest('Ninguém pede para a IA agir sobre si mesmo');

  // `input.room` is the agent's own LiveKit room (the main room or one of its breakouts).
  if (input.action === 'remove') await lk.remove(input.room, target.identity);
  else for (const sid of target.audioTrackSids) await lk.muteAudio(input.room, target.identity, sid);

  await audit(sql, {
    tenantId: room.tenantId,
    actorId,
    action: `moderation.${input.action}`,
    target: `${room.slug}:${target.identity}`,
    meta,
  });
  return {
    done: `${target.name} ${input.action === 'remove' ? 'foi removido da chamada' : 'teve o microfone silenciado'}`,
  };
}
