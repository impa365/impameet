import 'server-only';
import { config } from '../config';
import { db } from '../db';
import { lk } from '../livekit-client';
import { type RecordingEgress, liveKitEgress } from './egress';
import type { RecordingDeps } from './service';

let client: RecordingEgress | undefined;

/** Null when this installation has no recorder (RECORDINGS_DIR unset). */
export function recordingDeps(): (RecordingDeps & { recordingsDir: string }) | null {
  const cfg = config();
  if (!cfg.recordingsDir) return null;
  client ??= liveKitEgress(cfg.livekitApiUrl, cfg.livekitApiKey, cfg.livekitApiSecret);
  return {
    sql: db(),
    lk: lk(),
    egress: client,
    outputDir: cfg.egressOutputDir,
    recordingsDir: cfg.recordingsDir,
  };
}
