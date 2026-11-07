import type { LiveKitAdmin, LiveParticipant } from '../livekit-admin';
import { agentDispatchMetadata, roomAgents } from './service';
import { livekitRoomName } from '../livekit';
import { tenantLimits } from '../plans';
import type { Sql } from '../db';
import type { Room } from '../rooms/service';

/** The voice agent marks itself `impa.mode=voice`; captions and the AI screen are not it. */
export function isVoiceAgent(p: LiveParticipant): boolean {
  if (!p.isAgent) return false;
  if (p.mode) return p.mode === 'voice';
  return p.identity.startsWith('agent-');
}

export interface LiveAgentChange {
  removed: number;
  dispatched: number;
}

/**
 * Applies the room's agent list to a meeting that is already running: LiveKit only dispatches
 * agents when a room is created, so checking or unchecking an agent must act on the live room
 * too. Agents that joined without saying which one they are are replaced.
 */
export async function syncLiveAgents(
  sql: Sql,
  lk: LiveKitAdmin,
  agentName: string,
  room: Room,
): Promise<LiveAgentChange> {
  const lkRoom = livekitRoomName(room.tenantId, room.slug);
  const participants = await lk.listParticipants(lkRoom);
  const voice = participants.filter(isVoiceAgent);
  const people = participants.filter((p) => !p.isAgent);
  const allowed = (await tenantLimits(sql, room.tenantId)).agents;
  const wanted = allowed ? new Set(room.agentIds) : new Set<string>();

  let removed = 0;
  const present = new Set<string>();
  for (const agent of voice) {
    if (agent.agentId && wanted.has(agent.agentId) && !present.has(agent.agentId)) {
      present.add(agent.agentId);
      continue;
    }
    await lk.remove(lkRoom, agent.identity);
    removed++;
  }

  let dispatched = 0;
  if (people.length > 0) {
    for (const agent of await roomAgents(sql, room)) {
      if (!wanted.has(agent.id) || present.has(agent.id)) continue;
      await lk.dispatchAgent(
        lkRoom,
        agentName,
        agentDispatchMetadata(room.tenantId, agent, room.thinkingSound),
      );
      dispatched++;
    }
  }
  return { removed, dispatched };
}
