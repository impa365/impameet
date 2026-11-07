import { login } from '@/server/auth/service';
import { SESSION_COOKIE, createSession } from '@/server/auth/session';
import { config } from '@/server/config';
import { db } from '@/server/db';
import { notFound, tooManyRequests } from '@/server/errors';
import { assertSameOrigin, clientIp, handle, json, readJson, sessionCookie } from '@/server/http';
import { limits } from '@/server/limits';
import { currentTenant } from '@/server/request';
import { loginInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

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
    const session = await createSession(db(), user.id, { ip, userAgent: req.headers.get('user-agent') });
    return json({ user: { name: user.name, role: user.role } }, 200, {
      'set-cookie': sessionCookie(SESSION_COOKIE, session.token, session.expiresAt, config().secureCookies),
    });
  });
}
