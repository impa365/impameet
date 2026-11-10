import { setRequireMfa } from '@/server/auth/mfa';
import { db } from '@/server/db';
import { forbidden } from '@/server/errors';
import { readerUser, writerUser } from '@/server/guard';
import { clientIp, handle, json, readJson } from '@/server/http';
import { requireMfaInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

/** The organization's sign-in policy and how many people already use two-step verification. */
export async function GET(): Promise<Response> {
  return handle(async () => {
    const actor = await readerUser();
    if (actor.role !== 'admin') throw forbidden();
    const [row] = await db()<{ requireMfa: boolean; users: number; withMfa: number }[]>`
      select t.require_mfa as "requireMfa", count(u.id)::int as users,
             count(u.id) filter (where exists (
               select 1 from user_mfa m where m.user_id = u.id
                 and (m.totp_enabled_at is not null or m.email_enabled_at is not null))
               or exists (select 1 from webauthn_credentials w where w.user_id = u.id))::int as "withMfa"
      from tenants t left join users u on u.tenant_id = t.id and u.status = 'active'
      where t.id = ${actor.tenantId} group by t.require_mfa`;
    return json({ security: row });
  });
}

export async function PUT(req: Request): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    const { required } = await readJson(req, requireMfaInput);
    await setRequireMfa(db(), actor, required, clientIp(req));
    return json({ ok: true });
  });
}
