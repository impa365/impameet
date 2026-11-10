import { afterPassword } from '@/server/auth/mfa';
import { mfaDeps, relyingParty, startSession } from '@/server/mfa-client';
import { login } from '@/server/auth/service';
import { db } from '@/server/db';
import { notFound, tooManyRequests } from '@/server/errors';
import { assertSameOrigin, clientIp, handle, json, readJson } from '@/server/http';
import { limits } from '@/server/limits';
import { currentTenant } from '@/server/request';
import { loginInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

/** The password; then a session, a second step, or setting one up (when the organization requires it). */
export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(req);
    const ip = clientIp(req);
    if (!limits.loginPerIp.take(`login-ip:${ip}`)) throw tooManyRequests();

    const ctx = await currentTenant();
    if (!ctx) throw notFound('Organização não encontrada');
    const input = await readJson(req, loginInput);
    if (!limits.loginPerAccount.take(`login:${ctx.tenant.id}:${input.email}`)) throw tooManyRequests();

    const user = await login(db(), ctx.tenant, input, ip);
    const [{ requireMfa }] = await db()<{ requireMfa: boolean }[]>`
      select require_mfa as "requireMfa" from tenants where id = ${ctx.tenant.id}`;
    const next = await afterPassword(
      mfaDeps(),
      user,
      requireMfa,
      relyingParty(req, ctx.branding.productName),
      ip,
    );
    if (next.kind === 'session') return startSession(req, user, null);
    return json({ mfa: next });
  });
}
