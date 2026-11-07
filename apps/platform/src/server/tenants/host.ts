export type HostTarget =
  | { kind: 'root' }
  | { kind: 'slug'; slug: string }
  | { kind: 'domain'; hostname: string }
  | { kind: 'invalid' };

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Normalises a Host header: lower-case, no port, no trailing dot. */
export function normaliseHost(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const host = raw.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  if (!host || host.length > 253 || !host.split('.').every((l) => LABEL.test(l))) return null;
  return host;
}

/**
 * Maps a request host to a tenant reference:
 * - the platform domain itself -> root (default tenant or platform landing)
 * - `<slug>.<platform domain>` -> that tenant
 * - anything else -> a customer's own domain, looked up in tenant_domains
 */
export function classifyHost(rawHost: string | null | undefined, platformDomain: string): HostTarget {
  const host = normaliseHost(rawHost);
  if (!host) return { kind: 'invalid' };
  if (host === platformDomain) return { kind: 'root' };
  const suffix = `.${platformDomain}`;
  if (host.endsWith(suffix)) {
    const sub = host.slice(0, -suffix.length);
    return sub.includes('.') ? { kind: 'invalid' } : { kind: 'slug', slug: sub };
  }
  return { kind: 'domain', hostname: host };
}
