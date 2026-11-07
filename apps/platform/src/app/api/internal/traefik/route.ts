import { config } from '@/server/config';
import { db } from '@/server/db';
import { traefikDynamicConfig } from '@/server/domains/service';
import { json } from '@/server/http';
import { internalAuthorized } from '@/server/internal';

export const dynamic = 'force-dynamic';

/**
 * Polled by Traefik's HTTP provider (with the X-Internal-Token header) to route every
 * verified customer domain and tenant subdomain here, each with its own certificate.
 */
export async function GET(req: Request): Promise<Response> {
  const cfg = config();
  if (!internalAuthorized(req, cfg.internalToken)) {
    return json({ error: { code: 'not_found', message: 'Not found' } }, 404);
  }
  return json(
    await traefikDynamicConfig(db(), {
      platformDomain: cfg.platformDomain,
      service: process.env.TRAEFIK_SERVICE?.trim() || 'meet_platform@swarm',
      certResolver: process.env.TRAEFIK_CERT_RESOLVER?.trim() || 'letsencryptresolver',
      entryPoint: process.env.TRAEFIK_ENTRYPOINT?.trim() || 'websecure',
      includeTenantSubdomains: !cfg.defaultTenant,
    }),
  );
}
