import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { passkeyLogin, passkeyOptions } from '@/server/auth/mfa';
import { mfaDeps, relyingParty, startSession } from '@/server/auth/mfa-client';
import { notFound, tooManyRequests } from '@/server/errors';
import { assertSameOrigin, clientIp, handle, json, readJson } from '@/server/http';
import { limits } from '@/server/limits';
import { currentTenant } from '@/server/request';
import { passkeyLoginInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

/** "Entrar com passkey": the passkey alone, checked by the device (fingerprint, face or PIN). */
export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(req);
    const ip = clientIp(req);
    if (!limits.loginPerIp.take(`passkey-ip:${ip}`)) throw tooManyRequests();
    const ctx = await currentTenant();
    if (!ctx) throw notFound('Organização não encontrada');
    const input = await readJson(req, passkeyLoginInput);
    const rp = relyingParty(req, ctx.branding.productName);
    if (input.action === 'options') return json(await passkeyOptions(mfaDeps(), rp, ip));
    const user = await passkeyLogin(
      mfaDeps(),
      ctx.tenant.id,
      input.token,
      input.response as unknown as AuthenticationResponseJSON,
      rp,
    );
    return startSession(req, user, 'passkey');
  });
}
