import 'server-only';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

export type Env = Record<string, string | undefined>;

/** Reads `<NAME>_FILE` (Docker secret) first, then `<NAME>`; never logs the value. */
export function readSecret(env: Env, name: string): string | undefined {
  const file = env[`${name}_FILE`];
  if (file) {
    try {
      return readFileSync(file, 'utf8').trim() || undefined;
    } catch {
      throw new Error(`${name}_FILE points to an unreadable file`);
    }
  }
  return env[name]?.trim() || undefined;
}

const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/,
    'invalid hostname',
  );

const schema = z.object({
  databaseUrl: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL'),
  livekitUrl: z.string().regex(/^wss?:\/\/[^\s]+$/, 'must be a ws:// or wss:// URL'),
  livekitApiUrl: z.string().regex(/^https?:\/\/[^\s]+$/, 'must be an http(s):// URL'),
  internalToken: z.string().min(32).optional(),
  livekitApiKey: z.string().min(3),
  livekitApiSecret: z.string().min(32, 'must be at least 32 characters'),
  platformDomain: hostname,
  defaultTenant: z
    .string()
    .regex(/^[a-z0-9-]{1,40}$/)
    .optional(),
  agentName: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,62}$/)
    .default('kaiser'),
  secureCookies: z.boolean().default(true),
  /** Optional: where recordings are readable by the platform. Unset disables recording. */
  recordingsDir: z
    .string()
    .regex(/^\/[^\s]*$/)
    .optional(),
  /** The same directory as seen by the Egress container. */
  egressOutputDir: z
    .string()
    .regex(/^\/[^\s]*$/)
    .default('/out'),
  /** Optional SMTP (smtp:// or smtps://) for e-mail invites; a secret, since it carries the password. */
  smtpUrl: z
    .string()
    .regex(/^smtps?:\/\/\S+$/, 'must be an smtp:// or smtps:// URL')
    .optional(),
  mailFrom: z.string().min(3).max(200).optional(),
  /**
   * Host names AI agent tools may reach on a private network (e.g. "n8n" in the same Docker
   * network), over http or https. Every other tool URL must be https on the public internet.
   */
  toolsPrivateHosts: z.array(hostname).max(50).default([]),
  /** Master key (base64, 32 bytes) that encrypts provider API keys stored in the database. */
  encryptionKey: z
    .string()
    .regex(/^[A-Za-z0-9+/]{43}=$/, 'must be 32 bytes in base64')
    .optional(),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Env = process.env): Config {
  const parsed = schema.safeParse({
    databaseUrl: readSecret(env, 'DATABASE_URL'),
    livekitUrl: env.LIVEKIT_URL?.trim(),
    // Server-to-server calls can use the private address (e.g. http://livekit:7880).
    livekitApiUrl: env.LIVEKIT_API_URL?.trim() || env.LIVEKIT_URL?.trim().replace(/^ws/, 'http'),
    internalToken: readSecret(env, 'INTERNAL_TOKEN'),
    livekitApiKey: readSecret(env, 'LIVEKIT_API_KEY'),
    livekitApiSecret: readSecret(env, 'LIVEKIT_API_SECRET'),
    platformDomain: env.PLATFORM_DOMAIN,
    defaultTenant: env.DEFAULT_TENANT?.trim() || undefined,
    agentName: env.AGENT_NAME?.trim() || undefined,
    secureCookies: env.SECURE_COOKIES ? env.SECURE_COOKIES !== 'false' : undefined,
    recordingsDir: env.RECORDINGS_DIR?.trim() || undefined,
    egressOutputDir: env.EGRESS_OUTPUT_DIR?.trim() || undefined,
    smtpUrl: readSecret(env, 'SMTP_URL'),
    mailFrom: env.MAIL_FROM?.trim() || undefined,
    encryptionKey: readSecret(env, 'ENCRYPTION_KEY'),
    toolsPrivateHosts: (env.AGENT_TOOLS_PRIVATE_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
  });
  if (!parsed.success) {
    // Field names only: values may be secrets.
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`invalid configuration: ${fields}`);
  }
  return parsed.data;
}

let cached: Config | undefined;
export function config(): Config {
  cached ??= loadConfig();
  return cached;
}
