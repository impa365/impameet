import {
  EgressClient,
  EgressStatus,
  EncodedFileOutput,
  StreamOutput,
  StreamProtocol,
} from 'livekit-server-sdk';

export type EgressState = 'recording' | 'processing' | 'ready' | 'failed';

export interface EgressResult {
  state: EgressState;
  sizeBytes: number | null;
  durationS: number | null;
  error: string | null;
}

/** The slice of LiveKit Egress the platform uses (swappable in tests). */
export interface RecordingEgress {
  /** `layoutUrl`: a page of ours that composes the room (a studio's stage) instead of the grid. */
  start(room: string, filepath: string, layoutUrl?: string): Promise<string>;
  stop(egressId: string): Promise<void>;
  info(egressId: string): Promise<EgressResult | null>;
}

/** Live streaming: the same composed room, sent to RTMP servers instead of a file. */
export interface StreamEgress {
  /** `urls`: full RTMP(S) addresses with the stream key; never logged or stored by us. */
  stream(room: string, urls: string[], layoutUrl?: string): Promise<string>;
  stop(egressId: string): Promise<void>;
  info(egressId: string): Promise<EgressResult | null>;
}

export function egressState(status: EgressStatus): EgressState {
  switch (status) {
    case EgressStatus.EGRESS_STARTING:
    case EgressStatus.EGRESS_ACTIVE:
      return 'recording';
    case EgressStatus.EGRESS_ENDING:
      return 'processing';
    case EgressStatus.EGRESS_COMPLETE:
      return 'ready';
    default:
      return 'failed';
  }
}

export function liveKitEgress(
  apiUrl: string,
  apiKey: string,
  apiSecret: string,
): RecordingEgress & StreamEgress {
  const client = new EgressClient(apiUrl, apiKey, apiSecret);
  return {
    async stream(room, urls, layoutUrl) {
      const output = new StreamOutput({ protocol: StreamProtocol.RTMP, urls });
      const info = await client.startRoomCompositeEgress(
        room,
        output,
        layoutUrl ? { customBaseUrl: layoutUrl } : { layout: 'grid' },
      );
      return info.egressId;
    },
    async start(room, filepath, layoutUrl) {
      // No manifest: the platform tracks recordings itself and only ever deletes the MP4.
      const output = new EncodedFileOutput({ filepath, disableManifest: true });
      const info = await client.startRoomCompositeEgress(
        room,
        output,
        layoutUrl ? { customBaseUrl: layoutUrl } : { layout: 'grid' },
      );
      return info.egressId;
    },
    async stop(egressId) {
      await client.stopEgress(egressId);
    },
    async info(egressId) {
      const [info] = await client.listEgress({ egressId });
      if (!info) return null;
      const file = info.fileResults[0];
      return {
        state: egressState(info.status),
        sizeBytes: file ? Number(file.size) : null,
        // LiveKit reports nanoseconds.
        durationS: file ? Math.round(Number(file.duration) / 1e9) : null,
        error: info.error || null,
      };
    },
  };
}
