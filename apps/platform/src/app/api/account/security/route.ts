import { cookies } from 'next/headers';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import {
  emailConfirm,
  emailDisable,
  emailStart,
  passkeyRegister,
  passkeyRegisterOptions,
  passkeyRemove,
  passkeyRename,
  regenerateRecovery,
  securityOverview,
  totpConfirm,
  totpDisable,
  totpStart,
} from '@/server/auth/mfa';
import { mfaDeps, relyingParty } from '@/server/mfa-client';
import { SESSION_COOKIE, listSessions, revokeSessions } from '@/server/auth/session';
import { audit } from '@/server/audit';
import { db } from '@/server/db';
import { notFound } from '@/server/errors';
import { readerUser, writerUser } from '@/server/guard';
import { clientIp, handle, json, readJson } from '@/server/http';
import { currentTenant } from '@/server/request';
import { accountSecurityInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

const allowMfaSetup = { allowMfaSetup: true };

async function context(req: Request) {
  const ctx = await currentTenant();
  if (!ctx) throw notFound('Organização não encontrada');
  return { product: ctx.branding.productName, rp: relyingParty(req, ctx.branding.productName) };
}

/** The signed-in user's methods of verification and open sessions. */
export async function GET(req: Request): Promise<Response> {
  return handle(async () => {
    const user = await readerUser(allowMfaSetup);
    const { rp } = await context(req);
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    return json({
      security: await securityOverview(mfaDeps(), user, rp),
      sessions: await listSessions(db(), user.id, token),
    });
  });
}

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const user = await writerUser(req, allowMfaSetup);
    const input = await readJson(req, accountSecurityInput);
    const deps = mfaDeps();
    const ip = clientIp(req);
    const { product, rp } = await context(req);
    const who = { user };
    switch (input.action) {
      case 'totp-start':
        return json(await totpStart(deps, who, product));
      case 'totp-confirm':
        return json({ recoveryCodes: (await totpConfirm(deps, who, input.code, ip)).recoveryCodes ?? null });
      case 'totp-disable':
        await totpDisable(deps, user, input.password, ip);
        return json({ ok: true });
      case 'passkey-options':
        return json(await passkeyRegisterOptions(deps, who, rp, ip));
      case 'passkey-add': {
        const added = await passkeyRegister(
          deps,
          who,
          input.token,
          input.response as unknown as RegistrationResponseJSON,
          input.name,
          rp,
          ip,
        );
        return json({ recoveryCodes: added.recoveryCodes ?? null });
      }
      case 'passkey-rename':
        await passkeyRename(deps, user, input.id, input.name);
        return json({ ok: true });
      case 'passkey-remove':
        await passkeyRemove(deps, user, input.id, input.password, ip);
        return json({ ok: true });
      case 'email-start':
        return json(await emailStart(deps, who, product, ip));
      case 'email-confirm':
        return json({
          recoveryCodes: (await emailConfirm(deps, who, input.token, input.code, ip)).recoveryCodes ?? null,
        });
      case 'email-disable':
        await emailDisable(deps, user, input.password, ip);
        return json({ ok: true });
      case 'recovery-regenerate':
        return json({ recoveryCodes: await regenerateRecovery(deps, user, input.password, ip) });
      case 'session-revoke': {
        const token = (await cookies()).get(SESSION_COOKIE)?.value;
        const count = await revokeSessions(db(), user.id, input.id, token);
        await audit(db(), {
          tenantId: user.tenantId,
          actorId: user.id,
          action: 'auth.sessions_revoked',
          meta: { count },
          ip,
        });
        return json({ revoked: count });
      }
    }
  });
}
