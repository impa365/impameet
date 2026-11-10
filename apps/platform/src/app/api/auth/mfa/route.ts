import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import {
  type Enrolled,
  emailConfirm,
  emailStart,
  loginPasskeyOptions,
  passkeyRegister,
  passkeyRegisterOptions,
  sendLoginCode,
  totpConfirm,
  totpStart,
  verifyLogin,
} from '@/server/auth/mfa';
import { mfaDeps, relyingParty, startSession } from '@/server/mfa-client';
import { notFound, tooManyRequests } from '@/server/errors';
import { assertSameOrigin, clientIp, handle, json, readJson } from '@/server/http';
import { limits } from '@/server/limits';
import { currentTenant } from '@/server/request';
import { mfaInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

/** The second step of signing in (and setting it up when required), one action at a time. */
export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(req);
    const ip = clientIp(req);
    if (!limits.loginPerIp.take(`mfa-ip:${ip}`)) throw tooManyRequests();
    const ctx = await currentTenant();
    if (!ctx) throw notFound('Organização não encontrada');
    const input = await readJson(req, mfaInput);
    const deps = mfaDeps();
    const tenantId = ctx.tenant.id;
    const product = ctx.branding.productName;
    const rp = relyingParty(req, product);
    const enroller = { tenantId, token: input.token };
    const done = (e: Enrolled, method: string) =>
      startSession(req, e.user, method, e.recoveryCodes ? { recoveryCodes: e.recoveryCodes } : {});

    switch (input.action) {
      case 'send-email':
        return json(await sendLoginCode(deps, tenantId, input.token, product));
      case 'passkey-options':
        return json({ options: await loginPasskeyOptions(deps, tenantId, input.token, rp) });
      case 'verify-code':
      case 'verify-passkey': {
        const step =
          input.action === 'verify-code'
            ? { method: input.method, code: input.code }
            : {
                method: 'passkey' as const,
                response: input.response as unknown as AuthenticationResponseJSON,
              };
        const { user, method, recoveryLeft } = await verifyLogin(deps, tenantId, input.token, step, rp, ip);
        return startSession(req, user, method, recoveryLeft === undefined ? {} : { recoveryLeft });
      }
      case 'enroll-totp':
        return json(await totpStart(deps, enroller, product));
      case 'enroll-totp-confirm':
        return done(await totpConfirm(deps, enroller, input.code, ip), 'totp');
      case 'enroll-passkey-options':
        return json(await passkeyRegisterOptions(deps, enroller, rp, ip));
      case 'enroll-passkey':
        return done(
          await passkeyRegister(
            deps,
            enroller,
            input.token,
            input.response as unknown as RegistrationResponseJSON,
            input.name,
            rp,
            ip,
          ),
          'passkey',
        );
      case 'enroll-email':
        return json(await emailStart(deps, enroller, product, ip));
      case 'enroll-email-confirm':
        return done(await emailConfirm(deps, enroller, input.token, input.code, ip), 'email');
    }
  });
}
