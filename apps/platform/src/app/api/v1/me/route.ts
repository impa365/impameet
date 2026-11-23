import { listMembershipsByEmail } from '@/server/api-keys/service';
import { apiKeyContext, auditV1 } from '@/server/api-v1/auth';
import { handle, json } from '@/server/http';

export const dynamic = 'force-dynamic';

/** Who the key belongs to (email + memberships). Org header optional. */
export async function GET(req: Request): Promise<Response> {
  return handle(async () => {
    const ctx = await apiKeyContext(req, false);
    const orgs = await listMembershipsByEmail(ctx.sql, ctx.owner.email);
    const res = json({
      email: ctx.owner.email,
      keyId: ctx.owner.keyId,
      scopes: ctx.owner.scopes,
      orgs: orgs.map((o) => ({
        id: o.id,
        name: o.name,
        slug: o.slug,
        role: o.role,
        isSuperadmin: o.isSuperadmin,
      })),
    });
    auditV1(req, ctx, res.status);
    return res;
  });
}
