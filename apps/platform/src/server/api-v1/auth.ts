import 'server-only';
import type { SessionUser } from '../auth/session';
import {
  actorForOrg,
  findApiKeyOwner,
  recordApiKeyUse,
  requireBearer,
  requireOrgId,
  type ApiKeyOwner,
} from '../api-keys/service';
import { db, type Sql } from '../db';
import { tooManyRequests, unauthorized } from '../errors';
import { clientIp } from '../http';
import { limits } from '../limits';

export interface ApiV1Context {
  sql: Sql;
  owner: ApiKeyOwner;
  user: SessionUser | null;
  orgId: string | null;
  ip: string | null;
}

/** Authenticate the API key. Pass needsOrg=true for tenant-scoped routes. */
export async function apiKeyContext(req: Request, needsOrg: boolean): Promise<ApiV1Context> {
  const sql = db();
  const owner = await findApiKeyOwner(sql, requireBearer(req));
  if (!owner) throw unauthorized('Chave de API inválida ou revogada');
  if (!limits.writePerUser.take(`api:${owner.ownerUserId}`)) throw tooManyRequests();

  const headerOrg = (req.headers.get('x-impa-org') ?? '').trim().toLowerCase();
  const orgId = needsOrg ? requireOrgId(req) : headerOrg || null;
  const user = orgId ? await actorForOrg(sql, owner, orgId) : null;
  return { sql, owner, user, orgId, ip: clientIp(req) };
}

export async function requireApiUser(req: Request): Promise<ApiV1Context & { user: SessionUser }> {
  const ctx = await apiKeyContext(req, true);
  if (!ctx.user) throw unauthorized();
  return { ...ctx, user: ctx.user };
}

export function auditV1(req: Request, ctx: ApiV1Context, status: number): void {
  void recordApiKeyUse(ctx.sql, {
    keyId: ctx.owner.keyId,
    userId: ctx.user?.id ?? ctx.owner.ownerUserId,
    tenantId: ctx.orgId,
    method: req.method,
    path: new URL(req.url).pathname,
    status,
    ip: ctx.ip,
  }).catch(() => {});
}
