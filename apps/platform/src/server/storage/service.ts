import { stat } from 'node:fs/promises';
import type { z } from 'zod';
import { audit } from '../audit';
import type { SessionUser } from '../auth/session';
import type { Sql } from '../db';
import { AppError, badRequest, forbidden, notFound, tooManyRequests } from '../errors';
import { recordingPath, removeRecording } from '../recordings/files';
import { RateLimiter } from '../security/rate-limit';
import { type Resolver, assertPublicHttpsUrl, systemResolver } from '../security/public-url';
import { openSecret, sealSecret, secretHint } from '../security/secrets';
import type { driveStartInput, keepLocalInput, platformGoogleInput, s3StorageInput } from '../validation';
import {
  DRIVE_SCOPES,
  type Fetch,
  type GoogleClient,
  GoogleError,
  accessToken,
  authUrl,
  createFolder,
  downloadFile,
  exchangeCode,
  oauthStart,
  revoke,
  testFolder,
  uploadFile,
} from './google';
import { type S3Ops, type S3Settings, awsS3, objectKey, s3Error } from './s3';

export interface StorageDeps {
  sql: Sql;
  /** Null without an encryption key: then no secret can be stored. */
  key: Buffer | null;
  fetch?: Fetch;
  s3?: S3Ops;
  resolve?: Resolver;
  /** Where Egress leaves the files (null when this installation does not record). */
  recordingsDir: string | null;
  /** The platform's own address, for the fixed Google redirect URI. */
  platformUrl: string;
}

export type StorageKind = 's3' | 'gdrive';

const PLATFORM_AAD = 'google:platform';
const storageAad = (tenantId: string) => `storage:${tenantId}`;
export const stateAad = (state: string) => `oauth:${state}`;
export const STATE_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 6;
const tests = new RateLimiter(5, 10 * 60_000);
const connects = new RateLimiter(10, 10 * 60_000);

export const redirectUriOf = (platformUrl: string) =>
  `${platformUrl.replace(/\/+$/, '')}/api/oauth/google/callback`;

export function needKey(deps: Pick<StorageDeps, 'key'>): Buffer {
  if (!deps.key)
    throw new AppError(
      501,
      'encryption_disabled',
      'Configure a chave de criptografia do servidor (ENCRYPTION_KEY) para guardar credenciais',
    );
  return deps.key;
}

function assertAdmin(user: SessionUser) {
  if (user.role !== 'admin') throw forbidden('Só administradores configuram o armazenamento das gravações');
}

function assertSuperadmin(user: SessionUser) {
  if (!user.isSuperadmin) throw forbidden('Área exclusiva do super admin');
}

// --- The platform's Google client (super admin) ------------------------------------------

export interface PlatformGoogleView {
  encryption: boolean;
  clientId: string | null;
  hasSecret: boolean;
  /** What to register in the Google Cloud Console as the authorized redirect URI. */
  redirectUri: string;
  updatedAt: Date | null;
}

export async function platformGoogleRow(sql: Sql) {
  const [row] = await sql<{ clientId: string; sealed: string; updatedAt: Date }[]>`
    select client_id as "clientId", client_secret_sealed as sealed, updated_at as "updatedAt"
    from platform_google where id`;
  return row ?? null;
}

export async function getPlatformGoogle(deps: StorageDeps, actor: SessionUser): Promise<PlatformGoogleView> {
  assertSuperadmin(actor);
  const row = await platformGoogleRow(deps.sql);
  return {
    encryption: deps.key !== null,
    clientId: row?.clientId ?? null,
    hasSecret: Boolean(row),
    redirectUri: redirectUriOf(deps.platformUrl),
    updatedAt: row?.updatedAt ?? null,
  };
}

export async function savePlatformGoogle(
  deps: StorageDeps,
  actor: SessionUser,
  input: z.infer<typeof platformGoogleInput>,
  ip: string | null,
): Promise<PlatformGoogleView> {
  assertSuperadmin(actor);
  const key = needKey(deps);
  const current = await platformGoogleRow(deps.sql);
  if (!input.clientSecret && !current) throw badRequest('Informe o Client Secret');
  const sealed = input.clientSecret ? sealSecret(key, input.clientSecret, PLATFORM_AAD) : current!.sealed;
  await deps.sql`
    insert into platform_google (id, client_id, client_secret_sealed, updated_by)
    values (true, ${input.clientId}, ${sealed}, ${actor.id})
    on conflict (id) do update set client_id = excluded.client_id,
      client_secret_sealed = excluded.client_secret_sealed, updated_by = excluded.updated_by, updated_at = now()`;
  await audit(deps.sql, {
    tenantId: actor.tenantId,
    actorId: actor.id,
    action: 'platform.google_saved',
    target: 'google',
    meta: { secretChanged: Boolean(input.clientSecret) },
    ip,
  });
  return getPlatformGoogle(deps, actor);
}

/** The platform's Google client (Drive, YouTube), or null when not configured. */
export async function googleClient(deps: StorageDeps): Promise<GoogleClient | null> {
  const row = await platformGoogleRow(deps.sql);
  if (!row || !deps.key) return null;
  return {
    clientId: row.clientId,
    clientSecret: openSecret(deps.key, row.sealed, PLATFORM_AAD),
    redirectUri: redirectUriOf(deps.platformUrl),
  };
}

// --- An organization's destination (admin) ------------------------------------------------

interface StorageRow {
  tenantId: string;
  kind: StorageKind;
  endpoint: string | null;
  region: string | null;
  bucket: string | null;
  prefix: string;
  pathStyle: boolean;
  accessKey: string | null;
  googleEmail: string | null;
  folderId: string | null;
  folderName: string | null;
  sealed: string;
  secretHint: string;
  keepLocal: boolean;
  lastTestAt: Date | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
  updatedAt: Date;
}

const COLUMNS = (sql: Sql) => sql`
  tenant_id as "tenantId", kind, endpoint, region, bucket, prefix, path_style as "pathStyle",
  access_key as "accessKey", google_email as "googleEmail", folder_id as "folderId",
  folder_name as "folderName", secret_sealed as sealed, secret_hint as "secretHint",
  keep_local as "keepLocal", last_test_at as "lastTestAt", last_test_ok as "lastTestOk",
  last_test_error as "lastTestError", updated_at as "updatedAt"`;

async function storageRow(sql: Sql, tenantId: string): Promise<StorageRow | null> {
  const [row] = await sql<
    StorageRow[]
  >`select ${COLUMNS(sql)} from recording_storage where tenant_id = ${tenantId}`;
  return row ?? null;
}

/** What the panel shows: never a secret, only its last characters. */
export interface StorageView {
  encryption: boolean;
  /** The super admin configured the Google client (Drive can be connected). */
  googleAvailable: boolean;
  /** This installation records at all. */
  recording: boolean;
  storage: Omit<StorageRow, 'tenantId' | 'sealed' | 'folderId'> | null;
}

export async function getStorage(deps: StorageDeps, actor: SessionUser): Promise<StorageView> {
  assertAdmin(actor);
  const row = await storageRow(deps.sql, actor.tenantId);
  const { tenantId: _t, sealed: _s, folderId: _f, ...visible } = row ?? ({} as StorageRow);
  return {
    encryption: deps.key !== null,
    googleAvailable: Boolean(await platformGoogleRow(deps.sql)),
    recording: deps.recordingsDir !== null,
    storage: row ? visible : null,
  };
}

function s3Settings(row: StorageRow, key: Buffer): S3Settings {
  return {
    endpoint: row.endpoint,
    region: row.region ?? 'us-east-1',
    bucket: row.bucket ?? '',
    prefix: row.prefix,
    pathStyle: row.pathStyle,
    accessKey: row.accessKey ?? '',
    secretKey: openSecret(key, row.sealed, storageAad(row.tenantId)),
  };
}

/** S3 endpoints must be public HTTPS addresses (checked again before every upload). */
async function checkEndpoint(deps: StorageDeps, endpoint: string | null): Promise<string | null> {
  if (!endpoint) return null;
  return (await assertPublicHttpsUrl(endpoint, deps.resolve ?? systemResolver)).replace(/\/+$/, '');
}

export async function saveS3(
  deps: StorageDeps,
  actor: SessionUser,
  input: z.infer<typeof s3StorageInput>,
  ip: string | null,
): Promise<StorageView> {
  assertAdmin(actor);
  const key = needKey(deps);
  const current = await storageRow(deps.sql, actor.tenantId);
  const keepSecret = !input.secretKey && current?.kind === 's3' && current.accessKey === input.accessKey;
  if (!input.secretKey && !keepSecret) throw badRequest('Informe a chave secreta');
  const endpoint = await checkEndpoint(deps, input.endpoint);
  const settings: S3Settings = {
    endpoint,
    region: input.region,
    bucket: input.bucket,
    prefix: input.prefix,
    pathStyle: input.pathStyle,
    accessKey: input.accessKey,
    secretKey: input.secretKey ?? openSecret(key, current!.sealed, storageAad(actor.tenantId)),
  };
  // Saved only once it works: a real object is written and deleted in the bucket.
  try {
    await (deps.s3 ?? awsS3).test(settings);
  } catch (err) {
    throw badRequest(s3Error(err));
  }
  if (current?.kind === 'gdrive') await forgetGoogle(deps, current, key);
  await deps.sql`
    insert into recording_storage (tenant_id, kind, endpoint, region, bucket, prefix, path_style, access_key,
                                   secret_sealed, secret_hint, keep_local, last_test_at, last_test_ok)
    values (${actor.tenantId}, 's3', ${endpoint}, ${input.region}, ${input.bucket}, ${input.prefix},
            ${input.pathStyle}, ${input.accessKey},
            ${sealSecret(key, settings.secretKey, storageAad(actor.tenantId))}, ${secretHint(settings.secretKey)},
            ${input.keepLocal}, now(), true)
    on conflict (tenant_id) do update set kind = 's3', endpoint = excluded.endpoint, region = excluded.region,
      bucket = excluded.bucket, prefix = excluded.prefix, path_style = excluded.path_style,
      access_key = excluded.access_key, secret_sealed = excluded.secret_sealed, secret_hint = excluded.secret_hint,
      keep_local = excluded.keep_local, google_email = null, folder_id = null, folder_name = null,
      last_test_at = now(), last_test_ok = true, last_test_error = null, updated_at = now()`;
  await audit(deps.sql, {
    tenantId: actor.tenantId,
    actorId: actor.id,
    action: 'storage.saved',
    target: `s3:${input.bucket}`,
    meta: { keepLocal: input.keepLocal },
    ip,
  });
  return getStorage(deps, actor);
}

export async function setKeepLocal(
  deps: StorageDeps,
  actor: SessionUser,
  input: z.infer<typeof keepLocalInput>,
  ip: string | null,
): Promise<StorageView> {
  assertAdmin(actor);
  const result = await deps.sql`
    update recording_storage set keep_local = ${input.keepLocal}, updated_at = now()
    where tenant_id = ${actor.tenantId}`;
  if (result.count === 0) throw notFound('Nenhum armazenamento configurado');
  await audit(deps.sql, {
    tenantId: actor.tenantId,
    actorId: actor.id,
    action: 'storage.keep_local',
    target: 'storage',
    meta: { keepLocal: input.keepLocal },
    ip,
  });
  return getStorage(deps, actor);
}

async function forgetGoogle(deps: StorageDeps, row: StorageRow, key: Buffer): Promise<void> {
  try {
    await revoke(deps.fetch ?? fetch, openSecret(key, row.sealed, storageAad(row.tenantId)));
  } catch {
    // The stored token goes away below either way.
  }
}

/** Recordings stay on the server again; a Google connection is also revoked at Google. */
export async function removeStorage(deps: StorageDeps, actor: SessionUser, ip: string | null): Promise<void> {
  assertAdmin(actor);
  const row = await storageRow(deps.sql, actor.tenantId);
  if (!row) throw notFound('Nenhum armazenamento configurado');
  if (row.kind === 'gdrive' && deps.key) await forgetGoogle(deps, row, deps.key);
  await deps.sql`delete from recording_storage where tenant_id = ${actor.tenantId}`;
  await audit(deps.sql, {
    tenantId: actor.tenantId,
    actorId: actor.id,
    action: 'storage.removed',
    target: row.kind,
    ip,
  });
}

async function driveToken(deps: StorageDeps, row: StorageRow, key: Buffer): Promise<string> {
  const client = await googleClient(deps);
  if (!client) throw new GoogleError('O Google não está configurado nesta plataforma');
  return accessToken(deps.fetch ?? fetch, client, openSecret(key, row.sealed, storageAad(row.tenantId)));
}

export async function testStorage(
  deps: StorageDeps,
  actor: SessionUser,
): Promise<{ ok: boolean; error: string | null }> {
  assertAdmin(actor);
  if (!tests.take(actor.tenantId)) throw tooManyRequests();
  const key = needKey(deps);
  const row = await storageRow(deps.sql, actor.tenantId);
  if (!row) throw notFound('Nenhum armazenamento configurado');
  let error: string | null = null;
  try {
    if (row.kind === 's3') {
      await checkEndpoint(deps, row.endpoint);
      await (deps.s3 ?? awsS3).test(s3Settings(row, key));
    } else {
      await testFolder(deps.fetch ?? fetch, await driveToken(deps, row, key), row.folderId ?? '');
    }
  } catch (err) {
    error = err instanceof GoogleError || err instanceof AppError ? err.message : s3Error(err);
  }
  await deps.sql`
    update recording_storage set last_test_at = now(), last_test_ok = ${error === null}, last_test_error = ${error}
    where tenant_id = ${actor.tenantId}`;
  return { ok: error === null, error };
}

// --- Conectar com Google (Drive) ---------------------------------------------------------

/** Starts the connection: a one-time state bound to this admin, with a PKCE verifier. */
export async function startDrive(
  deps: StorageDeps,
  actor: SessionUser,
  input: z.infer<typeof driveStartInput>,
  returnUrl: string,
): Promise<{ url: string }> {
  assertAdmin(actor);
  if (!connects.take(actor.id)) throw tooManyRequests();
  const key = needKey(deps);
  const client = await googleClient(deps);
  if (!client) throw badRequest('O super admin ainda não configurou o Google nesta plataforma');
  const { state, verifier, challenge } = oauthStart();
  await deps.sql`delete from oauth_states where created_at < now() - make_interval(secs => ${STATE_TTL_MS / 1000})`;
  await deps.sql`
    insert into oauth_states (id, tenant_id, user_id, purpose, verifier_sealed, return_url, folder_name, keep_local)
    values (${state}, ${actor.tenantId}, ${actor.id}, 'drive', ${sealSecret(key, verifier, stateAad(state))},
            ${returnUrl}, ${input.folderName}, ${input.keepLocal})`;
  return { url: authUrl(client, state, challenge, DRIVE_SCOPES) };
}

/** Which "Conectar com Google" a state belongs to (Drive or YouTube), without using it up. */
export async function oauthPurpose(sql: Sql, state: string | null): Promise<'drive' | 'youtube' | null> {
  if (!state || state.length > 100) return null;
  const [row] = await sql<
    { purpose: 'drive' | 'youtube' }[]
  >`select purpose from oauth_states where id = ${state}`;
  return row?.purpose ?? null;
}

const withStatus = (url: string, status: string) => {
  const u = new URL(url);
  u.searchParams.set('storage', status);
  return u.toString();
};

/**
 * Google sends the person back here. The state is used once (deleted as it is read), must be
 * recent, and carries who started it; the code is exchanged with the PKCE verifier.
 * Returns where to send the browser (the admin page it came from, with the outcome).
 */
export async function finishDrive(
  deps: StorageDeps,
  params: { state: string | null; code: string | null; error: string | null },
  ip: string | null,
): Promise<string> {
  const key = needKey(deps);
  if (!params.state || params.state.length > 100) throw badRequest('Conexão inválida ou expirada');
  const [row] = await deps.sql<
    {
      tenantId: string;
      userId: string;
      verifierSealed: string;
      returnUrl: string;
      folderName: string | null;
      keepLocal: boolean;
      createdAt: Date;
    }[]
  >`
    delete from oauth_states where id = ${params.state} and purpose = 'drive'
    returning tenant_id as "tenantId", user_id as "userId", verifier_sealed as "verifierSealed",
              return_url as "returnUrl", folder_name as "folderName", keep_local as "keepLocal",
              created_at as "createdAt"`;
  if (!row || Date.now() - new Date(row.createdAt).getTime() > STATE_TTL_MS)
    throw badRequest('Conexão inválida ou expirada; comece de novo');
  if (params.error || !params.code) return withStatus(row.returnUrl, 'cancelled');
  const [admin] = await deps.sql<{ ok: boolean }[]>`
    select true as ok from users where id = ${row.userId} and tenant_id = ${row.tenantId} and role = 'admin'`;
  if (!admin) return withStatus(row.returnUrl, 'error');

  const client = await googleClient(deps);
  if (!client) return withStatus(row.returnUrl, 'error');
  const fetchImpl = deps.fetch ?? fetch;
  try {
    const verifier = openSecret(key, row.verifierSealed, stateAad(params.state));
    const granted = await exchangeCode(fetchImpl, client, params.code, verifier);
    if (!granted.scopes.includes('https://www.googleapis.com/auth/drive.file')) {
      await revoke(fetchImpl, granted.refreshToken);
      return withStatus(row.returnUrl, 'scope');
    }
    const folderName = row.folderName ?? 'IMPA Meet - Gravações';
    const folderId = await createFolder(fetchImpl, granted.accessToken, folderName);
    const previous = await storageRow(deps.sql, row.tenantId);
    if (previous?.kind === 'gdrive') await forgetGoogle(deps, previous, key);
    await deps.sql`
      insert into recording_storage (tenant_id, kind, google_email, folder_id, folder_name, secret_sealed,
                                     secret_hint, keep_local, last_test_at, last_test_ok)
      values (${row.tenantId}, 'gdrive', ${granted.email}, ${folderId}, ${folderName},
              ${sealSecret(key, granted.refreshToken, storageAad(row.tenantId))}, '', ${row.keepLocal}, now(), true)
      on conflict (tenant_id) do update set kind = 'gdrive', google_email = excluded.google_email,
        folder_id = excluded.folder_id, folder_name = excluded.folder_name, secret_sealed = excluded.secret_sealed,
        secret_hint = '', keep_local = excluded.keep_local, endpoint = null, region = null, bucket = null,
        prefix = '', path_style = false, access_key = null, last_test_at = now(), last_test_ok = true,
        last_test_error = null, updated_at = now()`;
    await audit(deps.sql, {
      tenantId: row.tenantId,
      actorId: row.userId,
      action: 'storage.connected',
      target: 'gdrive',
      meta: { account: granted.email ?? '', folder: folderName },
      ip,
    });
    return withStatus(row.returnUrl, 'connected');
  } catch {
    return withStatus(row.returnUrl, 'error');
  }
}

// --- Uploads, in the background ----------------------------------------------------------

interface Due {
  id: string;
  tenantId: string;
  roomName: string;
  fileName: string;
  startedAt: Date;
  attempts: number;
}

/** "Sala de vendas 2026-11-13 14h05 (ab12cd34).mp4": readable, unique, safe in any store. */
export function remoteName(roomName: string, startedAt: Date, id: string): string {
  const when = new Date(startedAt).toISOString();
  const room =
    roomName
      .replace(/[^\p{L}\p{N} _-]/gu, '')
      .trim()
      .slice(0, 80) || 'reuniao';
  return `${room} ${when.slice(0, 10)} ${when.slice(11, 13)}h${when.slice(14, 16)} (${id.slice(0, 8)}).mp4`;
}

const s3Key = (row: StorageRow, rec: Due) =>
  objectKey(row, remoteName(rec.roomName, rec.startedAt, rec.id).replace(/ /g, '_'));

async function uploadOne(deps: StorageDeps, key: Buffer, rec: Due): Promise<void> {
  const row = await storageRow(deps.sql, rec.tenantId);
  if (!row || !deps.recordingsDir) {
    await deps.sql`update recordings set storage_status = null, storage_kind = null where id = ${rec.id}`;
    return;
  }
  try {
    const path = recordingPath(deps.recordingsDir, rec.fileName);
    const info = await stat(path);
    let ref: string;
    let link: string | null = null;
    if (row.kind === 's3') {
      await checkEndpoint(deps, row.endpoint);
      ref = s3Key(row, rec);
      await (deps.s3 ?? awsS3).upload(s3Settings(row, key), ref, path);
    } else {
      const { createReadStream } = await import('node:fs');
      const { Readable } = await import('node:stream');
      const body = Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
      const token = await driveToken(deps, row, key);
      const file = await uploadFile(
        deps.fetch ?? fetch,
        token,
        row.folderId ?? '',
        remoteName(rec.roomName, rec.startedAt, rec.id),
        info.size,
        body,
      );
      ref = file.id;
      link = file.link;
    }
    if (!row.keepLocal) await removeRecording(deps.recordingsDir, rec.fileName);
    await deps.sql`
      update recordings set storage_status = 'done', storage_kind = ${row.kind}, storage_ref = ${ref},
        storage_link = ${link}, storage_error = null, storage_next_at = null, local_removed = ${!row.keepLocal}
      where id = ${rec.id}`;
  } catch (err) {
    const attempts = rec.attempts + 1;
    const message =
      err instanceof GoogleError || err instanceof AppError
        ? err.message
        : (err as { code?: string }).code === 'ENOENT'
          ? 'O arquivo da gravação não está mais no servidor'
          : s3Error(err);
    await deps.sql`
      update recordings set storage_status = 'failed', storage_attempts = ${attempts},
        storage_error = ${message.slice(0, 500)},
        storage_next_at = ${attempts >= MAX_ATTEMPTS ? null : new Date(Date.now() + attempts * attempts * 5 * 60_000)}
      where id = ${rec.id}`;
    await audit(deps.sql, {
      tenantId: rec.tenantId,
      actorId: null,
      action: 'storage.upload_failed',
      target: rec.id,
      meta: { attempt: attempts, error: message.slice(0, 200) },
      ip: null,
    });
  }
}

/**
 * Sends ready recordings to their organization's storage: recordings that finished after the
 * destination was set are queued, a few are uploaded at a time, failures are retried with a
 * growing pause (up to six times). An upload left halfway by a restart is picked up again.
 */
export async function storageTick(deps: StorageDeps, batch = 2): Promise<number> {
  if (!deps.key || !deps.recordingsDir) return 0;
  await deps.sql`
    update recordings r set storage_status = 'pending', storage_kind = s.kind, storage_next_at = now()
    from recording_storage s
    where s.tenant_id = r.tenant_id and r.status = 'ready' and r.storage_status is null
      and not r.local_removed and r.ended_at >= s.created_at`;
  const due = await deps.sql<Due[]>`
    update recordings set storage_status = 'uploading', storage_next_at = now() + interval '6 hours'
    where id in (
      select id from recordings
      where (storage_status in ('pending', 'failed') or storage_status = 'uploading')
        and storage_next_at <= now()
      order by storage_next_at limit ${batch} for update skip locked)
    returning id, tenant_id as "tenantId", room_name as "roomName", file_name as "fileName",
              started_at as "startedAt", storage_attempts as attempts`;
  for (const rec of due) await uploadOne(deps, deps.key, rec);
  return due.length;
}

/** Where a recording kept only in the organization's storage is downloaded from. */
export async function remoteDownload(
  deps: StorageDeps,
  rec: {
    id: string;
    tenantId: string;
    roomName: string;
    startedAt: Date;
    storageKind: StorageKind;
    storageRef: string;
  },
  fileName: string,
): Promise<{ redirect: string } | { response: Response }> {
  const key = needKey(deps);
  const row = await storageRow(deps.sql, rec.tenantId);
  if (!row || row.kind !== rec.storageKind) throw notFound('O armazenamento desta gravação foi desconectado');
  if (row.kind === 's3') {
    await checkEndpoint(deps, row.endpoint);
    return { redirect: await (deps.s3 ?? awsS3).signedGet(s3Settings(row, key), rec.storageRef, fileName) };
  }
  const token = await driveToken(deps, row, key);
  return { response: await downloadFile(deps.fetch ?? fetch, token, rec.storageRef) };
}
