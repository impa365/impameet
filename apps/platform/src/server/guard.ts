import 'server-only';
import type { SessionUser } from './auth/session';
import { tooManyRequests, unauthorized } from './errors';
import { assertSameOrigin } from './http';
import { limits } from './limits';
import { currentUser } from './request';

/** Signed-in user for a read request. */
export async function readerUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) throw unauthorized();
  return user;
}

/** Signed-in user for a state-changing request: same-origin and rate-limited. */
export async function writerUser(req: Request): Promise<SessionUser> {
  assertSameOrigin(req);
  const user = await readerUser();
  if (!limits.writePerUser.take(`write:${user.id}`)) throw tooManyRequests();
  return user;
}
