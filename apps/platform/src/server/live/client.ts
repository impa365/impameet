import 'server-only';
import { config } from '../config';
import { lk } from '../livekit-client';
import { type RecordingEgress, type StreamEgress, liveKitEgress } from '../recordings/egress';
import { storageDeps } from '../storage/client';
import type { LiveDeps } from './service';

let egress: (RecordingEgress & StreamEgress) | undefined;

/** Streaming uses the same Egress as recording: installed when recording is. */
export function liveDeps(): LiveDeps {
  const cfg = config();
  if (cfg.recordingsDir) egress ??= liveKitEgress(cfg.livekitApiUrl, cfg.livekitApiKey, cfg.livekitApiSecret);
  const base = storageDeps();
  return {
    ...base,
    lk: lk(),
    egress: cfg.recordingsDir ? (egress ?? null) : null,
    studioUrl: `${base.platformUrl}/studio/render`,
  };
}
