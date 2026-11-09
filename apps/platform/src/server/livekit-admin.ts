import {
  AgentDispatchClient,
  DataPacket_Kind,
  RoomServiceClient,
  TrackSource,
  TrackType,
} from 'livekit-server-sdk';

export interface LiveParticipant {
  identity: string;
  name: string;
  role: string;
  isAgent: boolean;
  /** What an agent participant is doing (e.g. "captions"); null for people and the voice agent. */
  mode?: string | null;
  /** Which configured agent a voice agent is (set by the worker when it joins). */
  agentId?: string | null;
  handRaised: boolean;
  audioTrackSids: string[];
  audioMuted: boolean;
  /** Camera tracks only (never a shared screen). */
  videoTrackSids?: string[];
  videoMuted?: boolean;
  joinedAt: number;
}

export interface LiveRoom {
  name: string;
  participants: number;
  createdAt: number;
}

/** The slice of LiveKit's server API the platform uses (swappable in tests). */
export interface LiveKitAdmin {
  listParticipants(room: string): Promise<LiveParticipant[]>;
  listRooms(): Promise<LiveRoom[]>;
  /** Mutes one published track (microphone or camera); its owner can turn it on again. */
  muteTrack(room: string, identity: string, trackSid: string): Promise<void>;
  remove(room: string, identity: string): Promise<void>;
  setRole(room: string, identity: string, role: string): Promise<void>;
  setAttributes(room: string, identity: string, attributes: Record<string, string>): Promise<void>;
  dispatchAgent(room: string, agentName: string, metadata: string): Promise<void>;
  /** Server-sent message to everyone in a room (reliable data packet on `topic`). */
  sendData(room: string, payload: string, topic: string): Promise<void>;
}

const PARTICIPANT_KIND_AGENT = 4;

export function liveKitAdmin(apiUrl: string, apiKey: string, apiSecret: string): LiveKitAdmin {
  const client = new RoomServiceClient(apiUrl, apiKey, apiSecret);
  const dispatch = new AgentDispatchClient(apiUrl, apiKey, apiSecret);
  return {
    async listParticipants(room) {
      const list = await client.listParticipants(room).catch((err: { status?: number }) => {
        if (err?.status === 404) return [];
        throw err;
      });
      return list.map((p) => {
        const audio = p.tracks.filter((t) => t.type === TrackType.AUDIO);
        const camera = p.tracks.filter((t) => t.type === TrackType.VIDEO && t.source === TrackSource.CAMERA);
        return {
          identity: p.identity,
          name: p.name || p.identity,
          role: p.attributes?.role ?? 'participant',
          isAgent: Number(p.kind) === PARTICIPANT_KIND_AGENT,
          mode: p.attributes?.['impa.mode'] ?? null,
          agentId: p.attributes?.['impa.agent'] ?? null,
          handRaised: Boolean(p.attributes?.hand),
          audioTrackSids: audio.map((t) => t.sid),
          audioMuted: audio.length === 0 || audio.every((t) => t.muted),
          videoTrackSids: camera.map((t) => t.sid),
          videoMuted: camera.length === 0 || camera.every((t) => t.muted),
          joinedAt: Number(p.joinedAt) * 1000,
        };
      });
    },
    async listRooms() {
      const rooms = await client.listRooms();
      return rooms.map((r) => ({
        name: r.name,
        participants: r.numParticipants,
        createdAt: Number(r.creationTime) * 1000,
      }));
    },
    async muteTrack(room, identity, trackSid) {
      await client.mutePublishedTrack(room, identity, trackSid, true);
    },
    async remove(room, identity) {
      await client.removeParticipant(room, identity);
    },
    async setRole(room, identity, role) {
      await client.updateParticipant(room, identity, { attributes: { role } });
    },
    async setAttributes(room, identity, attributes) {
      await client.updateParticipant(room, identity, { attributes });
    },
    async dispatchAgent(room, agentName, metadata) {
      await dispatch.createDispatch(room, agentName, { metadata });
    },
    async sendData(room, payload, topic) {
      await client
        .sendData(room, new TextEncoder().encode(payload), DataPacket_Kind.RELIABLE, { topic })
        .catch((err: { status?: number }) => {
          if (err?.status !== 404) throw err;
        });
    },
  };
}
