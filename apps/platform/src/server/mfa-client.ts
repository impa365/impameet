import 'server-only';
import { config } from './config';
import { db } from './db';
import { clientIp, json, sessionCookie } from './http';
import { mailDeps } from './mail/client';
import { tenantMailer } from './mail/service';
import { parseMasterKey } from './security/secrets';
import { type MfaDeps, type RelyingParty, relyingPartyFor } from './auth/mfa';
import { recordLogin } from './auth/service';
import { SESSION_COOKIE, type SessionUser, createSession } from './auth/session';

let key: Buffer | null | undefined;

export function mfaDeps(): MfaDeps {
  const cfg = config();
  key ??= cfg.encryptionKey ? parseMasterKey(cfg.encryptionKey) : null;
  return { sql: db(), key, mailerFor: (tenantId) => tenantMailer(mailDeps(), tenantId) };
}

/** Passkeys belong to the exact address the user is on (subdomain or custom domain). */
export function relyingParty(req: Request, name: string): RelyingParty {
  return relyingPartyFor(req.headers.get('host') ?? '', config().secureCookies, name);
}

/** Opens the session once every step is done, and records the sign-in. */
export async function startSession(
  req: Request,
  user: SessionUser,
  mfaMethod: string | null,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  const ip = clientIp(req);
  const session = await createSession(db(), user.id, {
    ip,
    userAgent: req.headers.get('user-agent'),
    mfaMethod,
  });
  await recordLogin(db(), user, ip, mfaMethod);
  return json({ user: { name: user.name, role: user.role }, ...extra }, 200, {
    'set-cookie': sessionCookie(SESSION_COOKIE, session.token, session.expiresAt, config().secureCookies),
  });
}
