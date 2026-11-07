import 'server-only';
import { cookies, headers } from 'next/headers';
import { cache } from 'react';
import { SESSION_COOKIE, type SessionUser, findSessionUser } from './auth/session';
import { config } from './config';
import { db } from './db';
import { classifyHost } from './tenants/host';
import {
  type Branding,
  type Tenant,
  findBranding,
  findTenantByDomain,
  findTenantBySlug,
} from './tenants/repo';

export interface TenantContext {
  tenant: Tenant;
  branding: Branding;
}

async function lookupTenant(host: string | null): Promise<Tenant | null> {
  const cfg = config();
  const target = classifyHost(host, cfg.platformDomain);
  switch (target.kind) {
    case 'root':
      return cfg.defaultTenant ? findTenantBySlug(db(), cfg.defaultTenant) : null;
    case 'slug':
      return findTenantBySlug(db(), target.slug);
    case 'domain':
      return findTenantByDomain(db(), target.hostname);
    default:
      return null;
  }
}

/** The active tenant served on this host, or null (platform landing / unknown host). */
export const currentTenant = cache(async (): Promise<TenantContext | null> => {
  const tenant = await lookupTenant((await headers()).get('host'));
  if (!tenant || tenant.status !== 'active') return null;
  return { tenant, branding: await findBranding(db(), tenant.id) };
});

export const currentUser = cache(async (): Promise<SessionUser | null> => {
  const ctx = await currentTenant();
  if (!ctx) return null;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return findSessionUser(db(), token, ctx.tenant.id);
});

export async function isPlatformRoot(): Promise<boolean> {
  return classifyHost((await headers()).get('host'), config().platformDomain).kind === 'root';
}
