import 'server-only';
import type { SessionUser } from './auth/session';
import { AppError, tooManyRequests, unauthorized } from './errors';
import { assertSameOrigin } from './http';
import { limits } from './limits';
import { currentUser } from './request';

export interface GuardOptions {
  /** The few routes that let someone set up two-step verification when it is required. */
  allowMfaSetup?: boolean;
}

/** Signed-in user for a read request. */
export async function readerUser(options: GuardOptions = {}): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) throw unauthorized();
  if (user.mfaSetupRequired && !options.allowMfaSetup)
    throw new AppError(
      403,
      'mfa_required',
      'Sua organização exige a verificação em duas etapas. Configure em Minha conta.',
    );
  return user;
}

/** Signed-in user for a state-changing request: same-origin and rate-limited. */
export async function writerUser(req: Request, options: GuardOptions = {}): Promise<SessionUser> {
  assertSameOrigin(req);
  const user = await readerUser(options);
  if (!limits.writePerUser.take(`write:${user.id}`)) throw tooManyRequests();
  return user;
}
