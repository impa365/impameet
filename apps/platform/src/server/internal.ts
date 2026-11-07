import { timingSafeEqual } from 'node:crypto';

/** Service-to-service calls (Traefik, voice worker) carry the shared X-Internal-Token. */
export function internalAuthorized(req: Request, expected: string | undefined): boolean {
  const given = req.headers.get('x-internal-token');
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
