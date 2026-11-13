import { agentDispatchMetadata, roomAgents } from '../agents/service';
import type { Config } from '../config';
import type { Sql } from '../db';
import { type ParticipantRole, issueJoinToken } from '../livekit';
import { capParticipants, tenantLimits } from '../plans';
import { roomStateOf } from '../room-state';
import type { CollabPolicy, Room } from './service';

export interface JoinGrant {
  serverUrl: string;
  token: string;
  role: ParticipantRole;
  roomName: string;
  policies: RoomPolicies;
  /** A live-show studio (stage, backstage, producer) rather than a meeting. */
  studio: boolean;
}

/** Who may draw on the board and create polls; sent at join and again whenever it changes. */
export interface RoomPolicies {
  board: CollabPolicy;
  polls: CollabPolicy;
}

export const POLICY_TOPIC = 'impa.policy';
/** Settings the voice agents in the room apply live (`{"thinkingSound": false, "agentActions": true}`). */
export const AGENT_SETTINGS_TOPIC = 'impa.agent';

export function roomPolicies(room: Pick<Room, 'boardPolicy' | 'pollsPolicy'>): RoomPolicies {
  return { board: room.boardPolicy, polls: room.pollsPolicy };
}

/** Token for one participant, honouring the room's and the plan's limits. */
export async function grantJoin(
  sql: Sql,
  cfg: Pick<Config, 'livekitApiKey' | 'livekitApiSecret' | 'livekitUrl' | 'agentName'>,
  room: Room,
  who: { identity: string; displayName: string; role: ParticipantRole; orgRole?: string },
): Promise<JoinGrant> {
  const limits = await tenantLimits(sql, room.tenantId);
  const withAgent = room.agentEnabled && limits.agents;
  const agents = withAgent ? await roomAgents(sql, room) : [];
  const token = await issueJoinToken({
    apiKey: cfg.livekitApiKey,
    apiSecret: cfg.livekitApiSecret,
    tenantId: room.tenantId,
    roomSlug: room.slug,
    identity: who.identity,
    displayName: who.displayName,
    role: who.role,
    orgRole: who.orgRole,
    agentName: agents.length > 0 ? cfg.agentName : undefined,
    agentMetadata: agents.map((a) => agentDispatchMetadata(room.tenantId, a, room)),
    maxParticipants: capParticipants(room.maxParticipants, limits.maxParticipants),
    // The room opens knowing its stage (a studio) and whether it is recorded or live.
    roomMetadata: JSON.stringify(await roomStateOf(sql, room)),
  });
  return {
    serverUrl: cfg.livekitUrl,
    token,
    role: who.role,
    roomName: room.name,
    policies: roomPolicies(room),
    studio: room.studio === true,
  };
}
