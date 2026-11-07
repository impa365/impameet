import { signup } from '@/server/auth/service';
import { SESSION_COOKIE, createSession } from '@/server/auth/session';
import { config } from '@/server/config';
import { db } from '@/server/db';
import { forbidden, tooManyRequests } from '@/server/errors';
import { assertSameOrigin, clientIp, handle, json, readJson, sessionCookie } from '@/server/http';
import { limits } from '@/server/limits';
import { classifyHost } from '@/server/tenants/host';
import { findTenantBySlug } from '@/server/tenants/repo';
import { signupInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

/**
 * New organizations are created on the platform domain. In single-organization installs
 * (DEFAULT_TENANT set) the first signup claims that organization and later ones are refused.
 */
export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(req);
    const ip = clientIp(req);
    if (!limits.signupPerIp.take(`signup:${ip}`)) throw tooManyRequests();

    const cfg = config();
    if (classifyHost(req.headers.get('host'), cfg.platformDomain).kind !== 'root') {
      throw forbidden('Crie organizações no endereço principal da plataforma');
    }
    const input = await readJson(req, signupInput);
    if (cfg.defaultTenant) {
      if (await findTenantBySlug(db(), cfg.defaultTenant))
        throw forbidden('Cadastro fechado nesta instalação');
      input.slug = cfg.defaultTenant;
    }

    // A self-hosted, single-organization install owns its server: no plan limits apply.
    const { tenant, user } = await signup(db(), input, ip, cfg.defaultTenant ? 'enterprise' : 'free');
    const singleTenant = cfg.defaultTenant === tenant.slug;
    const tenantHost = singleTenant ? cfg.platformDomain : `${tenant.slug}.${cfg.platformDomain}`;

    const headers = new Headers();
    if (singleTenant) {
      const session = await createSession(db(), user.id, { ip, userAgent: req.headers.get('user-agent') });
      headers.set(
        'set-cookie',
        sessionCookie(SESSION_COOKIE, session.token, session.expiresAt, cfg.secureCookies),
      );
    }
    const scheme = cfg.secureCookies ? 'https' : 'http';
    const next = singleTenant
      ? '/dashboard'
      : `${scheme}://${tenantHost}/login?email=${encodeURIComponent(user.email)}`;
    return json({ tenant: { slug: tenant.slug, name: tenant.name }, next }, 201, headers);
  });
}
