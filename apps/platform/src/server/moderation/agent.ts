import type { z } from 'zod';
import { audit } from '../audit';
import type { Sql } from '../db';
import { AppError, badRequest, forbidden, notFound, tooManyRequests } from '../errors';
import type { LiveKitAdmin, LiveParticipant } from '../livekit-admin';
import { livekitRoomName } from '../livekit';
import { decide, pendingRequests } from '../lobby/service';
import { type RecordingDeps, beginRecording, endRecording } from '../recordings/service';
import { RateLimiter } from '../security/rate-limit';
import { type Room, findRoom } from '../rooms/service';
import type { agentModerationInput } from '../validation';

export type AgentModerationInput = z.infer<typeof agentModerationInput>;

/** An AI agent never acts on more than this many people in ten minutes, in one room. */
const agentActions = new RateLimiter(10, 10 * 60_000);

const TOOL_FOR = {
  remove: 'remove',
  mute: 'mute',
  camera: 'camera',
  admit: 'lobby',
  deny: 'lobby',
  record_start: 'record',
  record_stop: 'record',
} as const;
/** Never on the agent's own initiative: only when a moderator in the call asks. */
const MODERATOR_ONLY = new Set(['camera', 'record_start', 'record_stop']);
const USER_IDENTITY = /^u-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-/;

interface ModeratingAgent {
  id: string;
  tenantId: string;
  name: string;
  moderationTools: string[];
  moderationRules: string;
}

export interface AgentModerationView {
  people: {
    identity: string;
    name: string;
    role: string;
    micOn: boolean;
    camOn: boolean;
    protected: boolean;
  }[];
  lobby: { id: string; name: string }[];
  /** False when the room's moderators switched the AI's actions off. */
  actions: boolean;
}

/** Thrown whenever a room's moderators have switched the AI's actions off. */
export function assertAgentActions(room: Room): void {
  if (!room.agentActions) throw forbidden('Os moderadores desligaram as ações da IA nesta sala');
}

/** The user behind a signed-in participant identity (`u-<user id>-…`). */
export function identityUserId(identity: string): string | null {
  return USER_IDENTITY.exec(identity)?.[1] ?? null;
}

/** The agent and the room it sits in. The LiveKit room must be one of its organization's rooms. */
export async function agentInRoom(
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
        camOn: p.videoMuted === false,
        protected: shielded.has(p.identity),
      })),
    lobby: (await pendingRequests(sql, room)).map((r) => ({ id: r.id, name: r.displayName })),
    actions: room.agentActions,
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
  recorder: RecordingDeps | null = null,
): Promise<{ done: string }> {
  const { agent, room } = await agentInRoom(sql, agentId, input.room);
  if (!agent.moderationTools.includes(TOOL_FOR[input.action]))
    throw forbidden('Este agente não tem permissão para essa ação');
  assertAgentActions(room);

  const people = await lk.listParticipants(input.room);
  const shielded = await protectedIdentities(sql, room, people);
  const requester = input.requestedBy ? people.find((p) => p.identity === input.requestedBy) : undefined;
  const byModerator = requester !== undefined && shielded.has(requester.identity) && !requester.isAgent;
  const byRule =
    !byModerator &&
    !MODERATOR_ONLY.has(input.action) &&
    agent.moderationRules.trim() !== '' &&
    (input.rule ?? '').trim() !== '';
  if (!byModerator && !byRule)
    throw forbidden(
      MODERATOR_ONLY.has(input.action)
        ? 'Só um moderador da reunião pode pedir isso'
        : 'Só um moderador da reunião ou uma regra definida pelo administrador autoriza isso',
    );
  if (!agentActions.take(`${agent.id}:${input.room}`)) throw tooManyRequests();

  const meta = {
    via: 'ai',
    agent: agent.name,
    requestedBy: requester?.name ?? '',
    rule: byRule ? (input.rule ?? '').slice(0, 200) : '',
  };
  const actorId = byModerator ? identityUserId(requester.identity) : null;

  if (input.action === 'record_start' || input.action === 'record_stop') {
    if (!recorder)
      throw new AppError(501, 'recording_disabled', 'A gravação não está instalada neste servidor');
    if (input.room !== livekitRoomName(room.tenantId, room.slug))
      throw badRequest('Só a sala principal pode ser gravada');
    if (input.action === 'record_start') {
      await beginRecording(recorder, room, actorId, null, meta);
      return { done: 'A gravação começou' };
    }
    await endRecording(recorder, room, actorId, null, meta);
    return { done: 'A gravação foi encerrada' };
  }

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
  else if (input.action === 'camera')
    for (const sid of target.videoTrackSids ?? []) await lk.muteTrack(input.room, target.identity, sid);
  else for (const sid of target.audioTrackSids) await lk.muteTrack(input.room, target.identity, sid);

  await audit(sql, {
    tenantId: room.tenantId,
    actorId,
    action: `moderation.${input.action}`,
    target: `${room.slug}:${target.identity}`,
    meta,
  });
  const what = {
    remove: 'foi removido da chamada',
    camera: 'teve a câmera desligada',
    mute: 'teve o microfone silenciado',
  };
  return { done: `${target.name} ${what[input.action]}` };
}
