import { randomBytes } from 'node:crypto';
import { audit } from '../audit';
import type { SessionUser } from '../auth/session';
import type { Sql } from '../db';
import { badRequest, conflict, forbidden, notFound } from '../errors';
import { tenantLimits } from '../plans';

export const VERIFY_PREFIX = '_impa-meet';
export const VERIFY_VALUE_PREFIX = 'impa-meet-verification=';

export interface CustomDomain {
  hostname: string;
  verificationToken: string;
  verifiedAt: Date | null;
  createdAt: Date;
}

export type TxtResolver = (name: string) => Promise<string[][]>;

function assertAdmin(user: SessionUser): void {
  if (user.role !== 'admin') throw forbidden('Só administradores podem gerenciar domínios');
}

export function verificationRecord(domain: Pick<CustomDomain, 'hostname' | 'verificationToken'>) {
  return {
    name: `${VERIFY_PREFIX}.${domain.hostname}`,
    value: `${VERIFY_VALUE_PREFIX}${domain.verificationToken}`,
  };
}

export async function listDomains(sql: Sql, actor: SessionUser): Promise<CustomDomain[]> {
  assertAdmin(actor);
  return sql<CustomDomain[]>`
    select hostname, verification_token as "verificationToken", verified_at as "verifiedAt",
           created_at as "createdAt"
    from tenant_domains where tenant_id = ${actor.tenantId} order by created_at`;
}

export async function addDomain(
  sql: Sql,
  actor: SessionUser,
  hostname: string,
  platformDomain: string,
  ip: string | null,
): Promise<CustomDomain> {
  assertAdmin(actor);
  if (!(await tenantLimits(sql, actor.tenantId)).customDomains) {
    throw forbidden('O plano atual não inclui domínio próprio');
  }
  if (hostname === platformDomain || hostname.endsWith(`.${platformDomain}`)) {
    throw badRequest('Use um domínio da sua empresa, não um endereço da plataforma');
  }
  try {
    const [domain] = await sql<CustomDomain[]>`
      insert into tenant_domains (hostname, tenant_id, verification_token)
      values (${hostname}, ${actor.tenantId}, ${randomBytes(16).toString('hex')})
      returning hostname, verification_token as "verificationToken", verified_at as "verifiedAt",
                created_at as "createdAt"`;
    await audit(sql, {
      tenantId: actor.tenantId,
      actorId: actor.id,
      action: 'domain.added',
      target: hostname,
      ip,
    });
    return domain;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw conflict('Este domínio já está cadastrado');
    throw err;
  }
}

/** Marks the domain verified when its TXT record carries this tenant's token. */
export async function verifyDomain(
  sql: Sql,
  actor: SessionUser,
  hostname: string,
  resolveTxt: TxtResolver,
  ip: string | null,
): Promise<CustomDomain> {
  assertAdmin(actor);
  const [domain] = await sql<CustomDomain[]>`
    select hostname, verification_token as "verificationToken", verified_at as "verifiedAt",
           created_at as "createdAt"
    from tenant_domains where hostname = ${hostname} and tenant_id = ${actor.tenantId}`;
  if (!domain) throw notFound('Domínio não encontrado');
  if (domain.verifiedAt) return domain;

  const record = verificationRecord(domain);
  const found = await resolveTxt(record.name).then(
    (records) => records.some((chunks) => chunks.join('').trim() === record.value),
    () => false,
  );
  if (!found)
    throw badRequest(
      `Registro TXT ${record.name} não encontrado ainda. A propagação pode levar alguns minutos.`,
    );

  const [verified] = await sql<CustomDomain[]>`
    update tenant_domains set verified_at = now() where hostname = ${hostname}
    returning hostname, verification_token as "verificationToken", verified_at as "verifiedAt",
              created_at as "createdAt"`;
  await audit(sql, {
    tenantId: actor.tenantId,
    actorId: actor.id,
    action: 'domain.verified',
    target: hostname,
    ip,
  });
  return verified;
}

export async function removeDomain(sql: Sql, actor: SessionUser, hostname: string, ip: string | null) {
  assertAdmin(actor);
  const result = await sql`
    delete from tenant_domains where hostname = ${hostname} and tenant_id = ${actor.tenantId}`;
  if (result.count === 0) throw notFound('Domínio não encontrado');
  await audit(sql, {
    tenantId: actor.tenantId,
    actorId: actor.id,
    action: 'domain.removed',
    target: hostname,
    ip,
  });
}

export interface TraefikOptions {
  platformDomain: string;
  service: string;
  certResolver: string;
  entryPoint: string;
  includeTenantSubdomains: boolean;
}

/**
 * Traefik HTTP-provider document: one router per verified customer domain (and per tenant
 * subdomain), each with its own Let's Encrypt certificate obtained on first request.
 */
export async function traefikDynamicConfig(sql: Sql, opts: TraefikOptions) {
  const hosts = new Set<string>();
  for (const { hostname } of await sql<{ hostname: string }[]>`
    select d.hostname from tenant_domains d join tenants t on t.id = d.tenant_id
    where d.verified_at is not null and t.status = 'active'`) {
    hosts.add(hostname);
  }
  if (opts.includeTenantSubdomains) {
    for (const { slug } of await sql<{ slug: string }[]>`select slug from tenants where status = 'active'`) {
      hosts.add(`${slug}.${opts.platformDomain}`);
    }
  }
  const routers: Record<string, unknown> = {};
  for (const host of [...hosts].sort()) {
    routers[`impa-meet-${host.replace(/[^a-z0-9]/g, '-')}`] = {
      rule: `Host(\`${host}\`)`,
      entryPoints: [opts.entryPoint],
      service: opts.service,
      tls: { certResolver: opts.certResolver },
    };
  }
  return { http: { routers } };
}
