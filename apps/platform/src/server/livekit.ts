import { AccessToken, RoomAgentDispatch, RoomConfiguration } from 'livekit-server-sdk';

export type ParticipantRole = 'moderator' | 'participant' | 'guest';

export const JOIN_TOKEN_TTL_SECONDS = 2 * 60 * 60;

/**
 * Tenants share one LiveKit server; the tenant id prefix keeps their rooms apart. Breakout
 * rooms add `~<n>` (a character room slugs never contain).
 */
export function livekitRoomName(tenantId: string, roomSlug: string, breakout = 0): string {
  return breakout > 0 ? `${tenantId}.${roomSlug}~${breakout}` : `${tenantId}.${roomSlug}`;
}

export interface JoinTokenRequest {
  apiKey: string;
  apiSecret: string;
  tenantId: string;
  roomSlug: string;
  identity: string;
  displayName: string;
  role: ParticipantRole;
  agentName?: string;
  /** One dispatch per agent in the room (see `agentDispatchMetadata`). */
  agentMetadata?: string[];
  maxParticipants?: number | null;
  /** 0 (default) is the main room; 1..n are its breakout rooms. */
  breakout?: number;
}

export async function issueJoinToken(req: JoinTokenRequest): Promise<string> {
  const room = livekitRoomName(req.tenantId, req.roomSlug, req.breakout);
  const token = new AccessToken(req.apiKey, req.apiSecret, {
    identity: req.identity,
    name: req.displayName,
    ttl: JOIN_TOKEN_TTL_SECONDS,
    attributes: { role: req.role },
  });
  token.addGrant({
    roomJoin: true,
    room,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    // Role and hand live in attributes: only the server may change them (see rooms/hand.ts).
    canUpdateOwnMetadata: false,
  });
  token.roomConfig = new RoomConfiguration({
    maxParticipants: req.maxParticipants ?? 0,
    agents: req.agentName
      ? (req.agentMetadata ?? [JSON.stringify({ agentId: null, tenantId: req.tenantId })]).map(
          (metadata) => new RoomAgentDispatch({ agentName: req.agentName, metadata }),
        )
      : [],
  });
  return token.toJwt();
}
