import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { badRequest } from '../errors';

export type Resolver = (host: string) => Promise<string[]>;

export const systemResolver: Resolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

function ipv4Private(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

export function isPublicIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return !ipv4Private(ip);
  if (v !== 6) return false;
  const lower = ip.toLowerCase();
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return !ipv4Private(mapped[1]);
  return !(
    lower === '::' ||
    lower === '::1' ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('fe8') ||
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb') ||
    lower.startsWith('ff')
  );
}

/**
 * Provider URLs come from organization admins and are called by our servers, so they must be
 * HTTPS on the public internet: never the database, the platform or other internal services.
 */
export async function assertPublicHttpsUrl(raw: string, resolve: Resolver = systemResolver): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw badRequest('URL inválida');
  }
  if (url.protocol !== 'https:') throw badRequest('Use uma URL https://');
  if (url.username || url.password) throw badRequest('A URL não pode ter usuário ou senha');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => []);
  if (addresses.length === 0 || !addresses.every(isPublicIp)) {
    throw badRequest('A URL precisa apontar para um endereço público na internet');
  }
  return url.toString().replace(/\/+$/, '');
}
