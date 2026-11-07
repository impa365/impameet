import type { Sql } from '../db';

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended';
  plan: string;
}

export interface Branding {
  productName: string;
  primaryColor: string;
  logoUrl: string | null;
  /** Language for people whose browser asks for none we support. */
  defaultLocale: string;
}

export const DEFAULT_BRANDING: Branding = {
  productName: 'IMPA Meet',
  primaryColor: '#246fe5',
  logoUrl: null,
  defaultLocale: 'pt-BR',
};

export async function findTenantBySlug(sql: Sql, slug: string): Promise<Tenant | null> {
  const [row] = await sql<Tenant[]>`
    select id, slug, name, status, plan from tenants where slug = ${slug}`;
  return row ?? null;
}

export async function findTenantByDomain(sql: Sql, hostname: string): Promise<Tenant | null> {
  const [row] = await sql<Tenant[]>`
    select t.id, t.slug, t.name, t.status, t.plan
    from tenant_domains d join tenants t on t.id = d.tenant_id
    where d.hostname = ${hostname} and d.verified_at is not null`;
  return row ?? null;
}

export async function findBranding(sql: Sql, tenantId: string): Promise<Branding> {
  const [row] = await sql<Branding[]>`
    select product_name as "productName", primary_color as "primaryColor", logo_url as "logoUrl",
           default_locale as "defaultLocale"
    from tenant_branding where tenant_id = ${tenantId}`;
  return row ?? DEFAULT_BRANDING;
}
