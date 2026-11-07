import 'server-only';
import { config } from './config';
import { type LiveKitAdmin, liveKitAdmin } from './livekit-admin';

let client: LiveKitAdmin | undefined;

export function lk(): LiveKitAdmin {
  const cfg = config();
  client ??= liveKitAdmin(cfg.livekitApiUrl, cfg.livekitApiKey, cfg.livekitApiSecret);
  return client;
}
