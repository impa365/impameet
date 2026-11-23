import 'server-only';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { SessionUser } from '../auth/session';
import type { Sql } from '../db';
import { badRequest, forbidden, notFound, unauthorized } from '../errors';
import { ORG_PERMISSIONS, type OrgPermission } from '../rbac/permissions';
import { hashToken } from '../security/tokens';

const KEY_PREFIX = 'impa_';
const MAX_KEYS_PER_USER = 20;

export interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface CreatedApiKey extends ApiKeyRow {
  /** Shown once — never stored in plaintext. */
  token: string;
}

function newSecret(): { token: string; prefix: string; hash: Buffer } {
  const body = randomBytes(32).toString('base64url');
  const token = `${KEY_PREFIX}${body}`;
  const prefix = token.slice(0, KEY_PREFIX.length + 8);
  return { token, prefix, hash: hashToken(token) };
}

function parseScopes(raw: string[] | undefined): string[] {
  if (!raw || raw.length === 0) return [];
  const allowed = new Set<string>(ORG_PERMISSIONS);
  const out = [...new Set(raw.map((s) => s.trim()).filter((s) => allowed.has(s)))];
  if (out.length === 0) throw badRequest('Nenhum escopo válido');
  return out;
}

/** Keys follow the person (email), so the same list appears in every org they belong to. */
export async function listApiKeys(sql: Sql, email: string): Promise<ApiKeyRow[]> {
  return sql<ApiKeyRow[]>`
    select k.id, k.name, k.prefix, k.scopes, k.last_used_at as "lastUsedAt",
           k.expires_at as "expiresAt", k.created_at as "createdAt"
    from user_api_keys k
    join users u on u.id = k.user_id
    where u.email = ${email} and k.revoked_at is null and u.status = 'active'
    order by k.created_at desc`;
}

export async function createApiKey(
  sql: Sql,
  user: SessionUser,
  input: { name: string; scopes?: string[]; expiresAt?: string | null },
): Promise<CreatedApiKey> {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 80) throw badRequest('Informe um nome para a chave');
  const scopes = parseScopes(input.scopes);
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) throw badRequest('Data de expiração inválida');
  if (expiresAt && expiresAt.getTime() <= Date.now()) throw badRequest('A expiração precisa ser no futuro');

  const [{ count }] = await sql<{ count: number }[]>`
    select count(*)::int as count
    from user_api_keys k
    join users u on u.id = k.user_id
    where u.email = ${user.email} and k.revoked_at is null`;
  if (count >= MAX_KEYS_PER_USER)
    throw forbidden(`Cada conta pode ter até ${MAX_KEYS_PER_USER} chaves ativas`);

  const secret = newSecret();
  const [row] = await sql<ApiKeyRow[]>`
    insert into user_api_keys (user_id, name, token_hash, prefix, scopes, expires_at)
    values (${user.id}, ${name}, ${secret.hash}, ${secret.prefix}, ${scopes}, ${expiresAt})
    returning id, name, prefix, scopes, last_used_at as "lastUsedAt",
              expires_at as "expiresAt", created_at as "createdAt"`;
  return { ...row, token: secret.token };
}

export async function revokeApiKey(sql: Sql, email: string, keyId: string): Promise<void> {
  const result = await sql`
    update user_api_keys k set revoked_at = now()
    from users u
    where k.id = ${keyId} and k.user_id = u.id and u.email = ${email}
      and k.revoked_at is null`;
  if (result.count === 0) throw notFound('Chave não encontrada');
}

export interface ApiKeyOwner {
  keyId: string;
  ownerUserId: string;
  email: string;
  scopes: string[];
}

/** Resolve a raw Bearer token to the owning account (email) and key metadata. */
export async function findApiKeyOwner(sql: Sql, token: string | undefined): Promise<ApiKeyOwner | null> {
  if (!token || !token.startsWith(KEY_PREFIX) || token.length > 120) return null;
  const hash = hashToken(token);
  const [row] = await sql<
    { keyId: string; ownerUserId: string; email: string; scopes: string[]; expiresAt: Date | null }[]
  >`
    select k.id as "keyId", u.id as "ownerUserId", u.email, k.scopes, k.expires_at as "expiresAt"
    from user_api_keys k
    join users u on u.id = k.user_id
    where k.token_hash = ${hash} and k.revoked_at is null and u.status = 'active'`;
  if (!row) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
  await sql`update user_api_keys set last_used_at = now() where id = ${row.keyId}`;
  return {
    keyId: row.keyId,
    ownerUserId: row.ownerUserId,
    email: row.email,
    scopes: row.scopes,
  };
}

export interface OrgMembership {
  id: string;
  name: string;
  slug: string;
  role: string;
  userId: string;
  isSuperadmin: boolean;
}

/** Every active org membership for this email (same person across tenants). */
export async function listMembershipsByEmail(sql: Sql, email: string): Promise<OrgMembership[]> {
  return sql<OrgMembership[]>`
    select t.id, t.name, t.slug, u.role, u.id as "userId",
           exists (select 1 from platform_superadmins sa where sa.user_id = u.id) as "isSuperadmin"
    from users u
    join tenants t on t.id = u.tenant_id
    where u.email = ${email} and u.status = 'active' and t.status = 'active'
    order by t.name`;
}

/**
 * Build a SessionUser for API/MCP calls in the chosen organization.
 * Membership is matched by email so one key works in every org the person belongs to.
 */
export async function actorForOrg(sql: Sql, owner: ApiKeyOwner, orgId: string): Promise<SessionUser> {
  const [row] = await sql<(Omit<SessionUser, 'permissions'> & { role: string })[]>`
    select u.id, u.tenant_id as "tenantId", u.email, u.name, u.role,
           exists (select 1 from platform_superadmins sa where sa.user_id = u.id) as "isSuperadmin"
    from users u
    join tenants t on t.id = u.tenant_id
    where u.email = ${owner.email} and u.tenant_id = ${orgId}
      and u.status = 'active' and t.status = 'active'`;
  if (!row) throw forbidden('Você não tem acesso a esta organização');

  const permRows = await sql<{ code: OrgPermission }[]>`
    select rp.permission_code as code
    from org_roles r
    join org_role_permissions rp on rp.role_id = r.id
    where r.tenant_id = ${row.tenantId} and r.key = ${row.role}
      and rp.permission_code not like 'platform.%'`;
  let permissions = permRows.map((p) => p.code);
  if (owner.scopes.length > 0) {
    const allowed = new Set(owner.scopes);
    permissions = permissions.filter((p) => allowed.has(p));
  }
  return { ...row, permissions };
}

export async function recordApiKeyUse(
  sql: Sql,
  meta: {
    keyId: string;
    userId: string;
    tenantId: string | null;
    method: string;
    path: string;
    status: number;
    ip: string | null;
  },
): Promise<void> {
  await sql`
    insert into user_api_key_audit (key_id, user_id, tenant_id, method, path, status, ip)
    values (${meta.keyId}, ${meta.userId}, ${meta.tenantId}, ${meta.method},
            ${meta.path.slice(0, 300)}, ${meta.status}, ${meta.ip})`;
}

export function requireBearer(req: Request): string {
  const header = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) throw unauthorized('Envie Authorization: Bearer impa_…');
  return match[1];
}

export const ORG_HEADER = 'x-impa-org';

export function requireOrgId(req: Request): string {
  const orgId = (req.headers.get(ORG_HEADER) ?? '').trim();
  const parsed = z.string().uuid().safeParse(orgId);
  if (!parsed.success) throw badRequest(`Informe a organização no header ${ORG_HEADER} (UUID)`);
  return parsed.data.toLowerCase();
}
