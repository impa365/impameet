import { ZodError, type ZodType } from 'zod';
import { AppError, badRequest, forbidden } from './errors';
import { normaliseHost } from './tenants/host';
import { firstIssue } from './validation';

export const MAX_JSON_BYTES = 16 * 1024;

export function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  // new Headers() accepts every HeadersInit form; spreading a Headers instance would drop its entries.
  const merged = new Headers(headers);
  merged.set('cache-control', 'no-store');
  return Response.json(body, { status, headers: merged });
}

/** Runs a route handler, turning known errors into JSON and hiding unexpected ones. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) return json({ error: { code: err.code, message: err.message } }, err.status);
    if (err instanceof ZodError)
      return json({ error: { code: 'bad_request', message: firstIssue(err) } }, 400);
    console.error('unhandled error', err instanceof Error ? err.name : typeof err);
    return json({ error: { code: 'internal', message: 'Erro inesperado. Tente novamente.' } }, 500);
  }
}

/**
 * CSRF guard for state-changing requests: the browser-set Origin must match the Host.
 * Together with SameSite=Lax cookies this blocks cross-site form and fetch submissions.
 */
export function assertSameOrigin(req: Request): void {
  const origin = req.headers.get('origin');
  const host = normaliseHost(req.headers.get('host'));
  let originHost: string | null = null;
  try {
    originHost = origin ? normaliseHost(new URL(origin).host) : null;
  } catch {
    originHost = null;
  }
  if (!host || !originHost || originHost !== host) throw forbidden('Origem da requisição não permitida');
}

export async function readJson<T>(req: Request, schema: ZodType<T>, maxBytes = MAX_JSON_BYTES): Promise<T> {
  if (!req.headers.get('content-type')?.includes('application/json')) throw badRequest('Envie JSON');
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw badRequest('Requisição muito grande');
  const text = await req.text();
  if (text.length > maxBytes) throw badRequest('Requisição muito grande');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw badRequest('JSON inválido');
  }
  return schema.parse(body);
}

/** Client IP as seen by the reverse proxy (Traefik sets X-Forwarded-For). */
export function clientIp(req: Request): string | null {
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || req.headers.get('x-real-ip') || null;
}

export function sessionCookie(name: string, token: string, expires: Date, secure: boolean): string {
  return [
    `${name}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${expires.toUTCString()}`,
    secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');
}

export function clearedCookie(name: string, secure: boolean): string {
  return [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0', secure ? 'Secure' : '']
    .filter(Boolean)
    .join('; ');
}
