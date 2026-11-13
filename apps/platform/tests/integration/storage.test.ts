import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signup } from '@/server/auth/service';
import type { SessionUser } from '@/server/auth/session';
import type { Sql } from '@/server/db';
import { AppError } from '@/server/errors';
import { recordingFileName } from '@/server/recordings/files';
import { deleteRecording } from '@/server/recordings/service';
import type { Fetch } from '@/server/storage/google';
import type { S3Ops, S3Settings } from '@/server/storage/s3';
import {
  type StorageDeps,
  finishDrive,
  getPlatformGoogle,
  getStorage,
  remoteDownload,
  remoteName,
  removeStorage,
  saveS3,
  savePlatformGoogle,
  setKeepLocal,
  startDrive,
  storageTick,
  testStorage,
} from '@/server/storage/service';
import { hashPassword } from '@/server/security/password';
import { driveStartInput, platformGoogleInput, s3StorageInput } from '@/server/validation';
import { type TestSql, freshDatabase } from './db';
import { READY_AGENT_KEY } from './ready-agent';

let sql: TestSql;
const db = () => sql as unknown as Sql;
const PASSWORD = 'senha-muito-segura';
const CLIENT_ID = '123456789012-abcdefghij0123456789.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-secret_0123456789';
let dir: string;

/** A fake S3: remembers what it was asked; `fail` makes the next calls throw like the SDK. */
class FakeS3 implements S3Ops {
  calls: string[] = [];
  seen: S3Settings[] = [];
  fail: string | null = null;
  async test(s: S3Settings) {
    this.seen.push(s);
    this.calls.push(`test ${s.bucket}`);
    if (this.fail) throw Object.assign(new Error('nope'), { name: this.fail });
  }
  async upload(s: S3Settings, key: string, filePath: string) {
    this.calls.push(`upload ${s.bucket} ${key} ${path.basename(filePath)}`);
    if (this.fail) throw Object.assign(new Error('nope'), { name: this.fail });
  }
  async signedGet(s: S3Settings, key: string) {
    return `https://signed.example/${s.bucket}/${encodeURIComponent(key)}?X-Amz-Expires=300`;
  }
  async remove(_s: S3Settings, key: string) {
    this.calls.push(`remove ${key}`);
  }
}

/** Google's endpoints, as far as these flows use them. */
function fakeGoogle(opts: { scope?: string; failUpload?: boolean } = {}) {
  const calls: string[] = [];
  const idToken = `x.${Buffer.from(JSON.stringify({ email: 'gravacoes@acme.com', email_verified: true })).toString('base64url')}.y`;
  const fn = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.split('?')[0]}`);
    if (url === 'https://oauth2.googleapis.com/token') {
      const body = new URLSearchParams(String(init?.body));
      if (body.get('grant_type') === 'authorization_code')
        return Response.json({
          refresh_token: 'refresh-0123456789',
          access_token: 'access-1',
          id_token: idToken,
          scope:
            opts.scope ??
            'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.file',
        });
      return Response.json({ access_token: 'access-2' });
    }
    if (url === 'https://oauth2.googleapis.com/revoke') return new Response('{}');
    if (url.startsWith('https://www.googleapis.com/drive/v3/files?fields=id'))
      return Response.json({ id: 'folder-1' });
    if (url.startsWith('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart'))
      return Response.json({ id: 'test-file' });
    if (url.startsWith('https://www.googleapis.com/drive/v3/files/') && method === 'DELETE')
      return new Response(null);
    if (url.startsWith('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable'))
      return new Response(null, {
        headers: { location: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=abc' },
      });
    if (url.startsWith('https://www.googleapis.com/upload/drive/v3/files?upload_id=abc'))
      return opts.failUpload
        ? Response.json({ error: { status: 'RESOURCE_EXHAUSTED' } }, { status: 403 })
        : Response.json({ id: 'file-9', webViewLink: 'https://drive.google.com/file/d/file-9/view' });
    if (url.includes('/drive/v3/files/file-9?alt=media'))
      return new Response('video-bytes', { headers: { 'content-length': '11' } });
    return new Response('{}', { status: 404 });
  }) as unknown as Fetch;
  return { fn, calls };
}

const deps = (over: Partial<StorageDeps> = {}): StorageDeps => ({
  sql: db(),
  key: READY_AGENT_KEY,
  recordingsDir: dir,
  platformUrl: 'https://meet.example.com',
  resolve: async () => ['93.184.215.14'],
  ...over,
});

beforeAll(async () => {
  sql = await freshDatabase();
  dir = await mkdtemp(path.join(tmpdir(), 'impa-rec-'));
});
afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await sql`truncate tenants, audit_log, platform_google restart identity cascade`;
});

async function expectAppError(promise: Promise<unknown>, status: number, message?: RegExp) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).status).toBe(status);
  if (message) expect((err as AppError).message).toMatch(message);
}

async function org(slug: string) {
  const { tenant, user } = await signup(
    db(),
    { organization: `Org ${slug}`, slug, name: 'Admin', email: `admin@${slug}.test`, password: PASSWORD },
    null,
    'enterprise',
  );
  const [member] = await sql<SessionUser[]>`
    insert into users (tenant_id, email, name, password_hash, role)
    values (${tenant.id}, ${`bia@${slug}.test`}, 'Bia', ${await hashPassword(PASSWORD)}, 'member')
    returning id, tenant_id as "tenantId", email, name, role, is_superadmin as "isSuperadmin"`;
  return { tenant, admin: user, member, root: { ...user, isSuperadmin: true } };
}

const s3 = (over: Record<string, unknown> = {}) =>
  s3StorageInput.parse({
    endpoint: 'https://acct.r2.cloudflarestorage.com/',
    region: 'auto',
    bucket: 'impa-gravacoes',
    prefix: '/reunioes/',
    pathStyle: false,
    accessKey: 'AKIA0123456789',
    secretKey: 'super-secret-0123456789',
    keepLocal: false,
    ...over,
  });

/** A ready recording whose file Egress left in the recordings folder. */
async function readyRecording(tenantId: string, endedAt = new Date(Date.now() + 1000)) {
  const id = randomUUID();
  const fileName = recordingFileName(tenantId, id);
  await writeFile(path.join(dir, fileName), 'mp4-bytes');
  await sql`
    insert into recordings (id, tenant_id, room_name, file_name, status, started_at, ended_at)
    values (${id}, ${tenantId}, 'Sala de vendas', ${fileName}, 'ready', ${new Date('2026-11-13T14:05:00Z')}, ${endedAt})`;
  return { id, fileName };
}

describe('the platform Google client', () => {
  it('is set by the super admin only, and its secret is never shown again', async () => {
    const { admin, root } = await org('acme');
    await expectAppError(getPlatformGoogle(deps(), admin), 403);
    expect(await getPlatformGoogle(deps(), root)).toMatchObject({
      clientId: null,
      hasSecret: false,
      redirectUri: 'https://meet.example.com/api/oauth/google/callback',
    });
    const input = (over = {}) =>
      platformGoogleInput.parse({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, ...over });
    await expectAppError(savePlatformGoogle(deps(), root, input({ clientSecret: '' }), null), 400);
    const saved = await savePlatformGoogle(deps(), root, input(), null);
    expect(saved).toMatchObject({ clientId: CLIENT_ID, hasSecret: true });
    expect(JSON.stringify(saved)).not.toContain(CLIENT_SECRET);
    const [{ sealed }] = await sql<
      { sealed: string }[]
    >`select client_secret_sealed as sealed from platform_google`;
    expect(sealed).not.toContain(CLIENT_SECRET);
    // Empty secret keeps the saved one.
    expect(await savePlatformGoogle(deps(), root, input({ clientSecret: '' }), null)).toMatchObject({
      hasSecret: true,
    });
    await expectAppError(savePlatformGoogle(deps({ key: null }), root, input(), null), 501);
    expect(() =>
      platformGoogleInput.parse({ clientId: 'not-a-client-id', clientSecret: CLIENT_SECRET }),
    ).toThrow();
  });
});

describe('S3 storage', () => {
  it('is saved only after a real test write, never shows the secret, and admins only', async () => {
    const { tenant, admin, member } = await org('acme');
    const fake = new FakeS3();
    await expectAppError(saveS3(deps({ s3: fake }), member, s3(), null), 403);
    fake.fail = 'AccessDenied';
    await expectAppError(saveS3(deps({ s3: fake }), admin, s3(), null), 400, /recusou a chave/);
    expect((await getStorage(deps(), admin)).storage).toBeNull();
    fake.fail = null;
    const view = await saveS3(deps({ s3: fake }), admin, s3(), null);
    expect(view.storage).toMatchObject({
      kind: 's3',
      endpoint: 'https://acct.r2.cloudflarestorage.com',
      bucket: 'impa-gravacoes',
      prefix: 'reunioes',
      keepLocal: false,
      secretHint: expect.stringMatching(/6789$/),
      lastTestOk: true,
    });
    expect(JSON.stringify(view)).not.toContain('super-secret');
    const [{ sealed }] = await sql<{ sealed: string }[]>`
      select secret_sealed as sealed from recording_storage where tenant_id = ${tenant.id}`;
    expect(sealed).not.toContain('super-secret');
    // Same access key: the secret may be left empty; another key needs its secret.
    await saveS3(deps({ s3: fake }), admin, s3({ secretKey: '', bucket: 'outro-bucket' }), null);
    expect(fake.seen.at(-1)).toMatchObject({ bucket: 'outro-bucket', secretKey: 'super-secret-0123456789' });
    await expectAppError(
      saveS3(deps({ s3: fake }), admin, s3({ secretKey: '', accessKey: 'OTHERKEY0' }), null),
      400,
    );
    // Only public HTTPS endpoints.
    await expectAppError(
      saveS3(
        deps({ s3: fake, resolve: async () => ['10.0.0.5'] }),
        admin,
        s3({ endpoint: 'https://minio.internal' }),
        null,
      ),
      400,
    );
    expect(() => s3({ bucket: 'Bucket_Ruim' })).toThrow();
    expect(() => s3({ prefix: '../fora' })).toThrow();
    expect(() => s3({ keepLocal: undefined })).toThrow();

    expect((await setKeepLocal(deps(), admin, { keepLocal: true }, null)).storage).toMatchObject({
      keepLocal: true,
    });
    fake.fail = 'NoSuchBucket';
    expect(await testStorage(deps({ s3: fake }), admin)).toEqual({
      ok: false,
      error: 'O bucket não foi encontrado: confira o nome e a região',
    });
    await removeStorage(deps(), admin, null);
    expect((await getStorage(deps(), admin)).storage).toBeNull();
    await expectAppError(removeStorage(deps(), admin, null), 404);
  });

  it('uploads ready recordings, removes the server copy when asked, and retries failures', async () => {
    const { tenant, admin } = await org('acme');
    const fake = new FakeS3();
    // A recording that finished before the destination existed is not sent.
    const old = await readyRecording(tenant.id, new Date(Date.now() - 60_000));
    await saveS3(deps({ s3: fake }), admin, s3(), null);
    const rec = await readyRecording(tenant.id);

    expect(await storageTick(deps({ s3: fake }))).toBe(1);
    const key = `reunioes/${remoteName('Sala de vendas', new Date('2026-11-13T14:05:00Z'), rec.id).replace(/ /g, '_')}`;
    expect(fake.calls.at(-1)).toBe(`upload impa-gravacoes ${key} ${rec.fileName}`);
    const [row] = await sql`
      select storage_status, storage_kind, storage_ref, local_removed from recordings where id = ${rec.id}`;
    expect(row).toMatchObject({
      storage_status: 'done',
      storage_kind: 's3',
      storage_ref: key,
      local_removed: true,
    });
    expect(existsSync(path.join(dir, rec.fileName))).toBe(false);
    const [untouched] = await sql`select storage_status from recordings where id = ${old.id}`;
    expect(untouched.storage_status).toBeNull();

    const download = await remoteDownload(
      deps({ s3: fake }),
      {
        id: rec.id,
        tenantId: tenant.id,
        roomName: 'Sala',
        startedAt: new Date(),
        storageKind: 's3',
        storageRef: key,
      },
      'Sala.mp4',
    );
    expect(download).toEqual({ redirect: expect.stringContaining('X-Amz-Expires=300') });

    // A failure is retried later, with the reason kept for the list.
    const second = await readyRecording(tenant.id);
    fake.fail = 'InvalidAccessKeyId';
    expect(await storageTick(deps({ s3: fake }))).toBe(1);
    const [failed] = await sql`
      select storage_status, storage_attempts, storage_error, storage_next_at > now() as later
      from recordings where id = ${second.id}`;
    expect(failed).toMatchObject({ storage_status: 'failed', storage_attempts: 1, later: true });
    expect(failed.storage_error).toMatch(/recusou a chave/);
    expect(existsSync(path.join(dir, second.fileName))).toBe(true);
    expect(await storageTick(deps({ s3: fake }))).toBe(0);

    // Deleting waits for an upload in progress.
    await sql`update recordings set storage_status = 'uploading' where id = ${second.id}`;
    await expectAppError(
      deleteRecording(db(), admin, second.id, async () => undefined, null),
      409,
    );
  });
});

describe('Google Drive storage', () => {
  async function withGoogle(root: SessionUser) {
    await savePlatformGoogle(
      deps(),
      root,
      platformGoogleInput.parse({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
      null,
    );
  }

  it('connects with OAuth + PKCE through a one-time state, and uploads into its own folder', async () => {
    const { tenant, admin, member, root } = await org('acme');
    const start = driveStartInput.parse({ folderName: 'Gravações IMPA', keepLocal: true });
    const back = 'https://acme.example.com/admin?tab=storage';
    await expectAppError(startDrive(deps(), admin, start, back), 400, /super admin/);
    await withGoogle(root);
    await expectAppError(startDrive(deps(), member, start, back), 403);
    const { url } = await startDrive(deps(), admin, start, back);
    const auth = new URL(url);
    expect(auth.origin + auth.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(auth.searchParams)).toMatchObject({
      client_id: CLIENT_ID,
      redirect_uri: 'https://meet.example.com/api/oauth/google/callback',
      code_challenge_method: 'S256',
      access_type: 'offline',
      scope: 'openid email https://www.googleapis.com/auth/drive.file',
    });
    const state = auth.searchParams.get('state')!;
    const [stored] = await sql`select verifier_sealed from oauth_states where id = ${state}`;
    expect(stored.verifier_sealed).not.toContain(auth.searchParams.get('code_challenge'));

    const google = fakeGoogle();
    const done = await finishDrive(deps({ fetch: google.fn }), { state, code: 'code-1', error: null }, null);
    expect(done).toBe(`${back}&storage=connected`);
    const view = await getStorage(deps(), admin);
    expect(view.storage).toMatchObject({
      kind: 'gdrive',
      googleEmail: 'gravacoes@acme.com',
      folderName: 'Gravações IMPA',
      keepLocal: true,
    });
    expect(JSON.stringify(view)).not.toContain('refresh-0123456789');
    // The state is used once.
    await expectAppError(
      finishDrive(deps({ fetch: google.fn }), { state, code: 'code-1', error: null }, null),
      400,
    );
    await expectAppError(finishDrive(deps(), { state: null, code: 'x', error: null }, null), 400);

    const rec = await readyRecording(tenant.id);
    expect(await storageTick(deps({ fetch: google.fn }))).toBe(1);
    const [row] = await sql`
      select storage_status, storage_ref, storage_link, local_removed from recordings where id = ${rec.id}`;
    expect(row).toMatchObject({
      storage_status: 'done',
      storage_ref: 'file-9',
      storage_link: 'https://drive.google.com/file/d/file-9/view',
      local_removed: false,
    });
    expect(existsSync(path.join(dir, rec.fileName))).toBe(true);
    const download = await remoteDownload(
      deps({ fetch: google.fn }),
      {
        id: rec.id,
        tenantId: tenant.id,
        roomName: 'Sala',
        startedAt: new Date(),
        storageKind: 'gdrive',
        storageRef: 'file-9',
      },
      'Sala.mp4',
    );
    expect('response' in download && (await download.response.text())).toBe('video-bytes');
    expect(await testStorage(deps({ fetch: google.fn }), admin)).toEqual({ ok: true, error: null });

    // Disconnecting revokes the access at Google.
    await removeStorage(deps({ fetch: google.fn }), admin, null);
    expect(google.calls).toContain('POST https://oauth2.googleapis.com/revoke');
  });

  it('refuses a missing Drive permission, a cancelled consent and an expired or foreign state', async () => {
    const { admin, root } = await org('acme');
    await withGoogle(root);
    const start = driveStartInput.parse({ folderName: 'Gravações', keepLocal: false });
    const begin = async () =>
      new URL(
        (await startDrive(deps(), admin, start, 'https://acme.example.com/admin?tab=storage')).url,
      ).searchParams.get('state')!;

    const noDrive = fakeGoogle({ scope: 'openid email' });
    expect(
      await finishDrive(deps({ fetch: noDrive.fn }), { state: await begin(), code: 'c', error: null }, null),
    ).toMatch(/storage=scope$/);
    expect(noDrive.calls).toContain('POST https://oauth2.googleapis.com/revoke');
    expect(
      await finishDrive(deps(), { state: await begin(), code: null, error: 'access_denied' }, null),
    ).toMatch(/storage=cancelled$/);
    const late = await begin();
    await sql`update oauth_states set created_at = now() - interval '11 minutes' where id = ${late}`;
    await expectAppError(finishDrive(deps(), { state: late, code: 'c', error: null }, null), 400);
    // Someone who is no longer an admin cannot finish what they started.
    const demoted = await begin();
    await sql`update users set role = 'member' where id = ${admin.id}`;
    expect(
      await finishDrive(deps({ fetch: fakeGoogle().fn }), { state: demoted, code: 'c', error: null }, null),
    ).toMatch(/storage=error$/);
    expect((await sql`select count(*)::int as n from recording_storage`)[0].n).toBe(0);
  });

  it('keeps the server copy and the reason when the Drive upload fails', async () => {
    const { tenant, admin, root } = await org('acme');
    await withGoogle(root);
    const start = driveStartInput.parse({ folderName: 'Gravações', keepLocal: false });
    const state = new URL(
      (await startDrive(deps(), admin, start, 'https://acme.example.com/a')).url,
    ).searchParams.get('state')!;
    const google = fakeGoogle({ failUpload: true });
    await finishDrive(deps({ fetch: google.fn }), { state, code: 'c', error: null }, null);
    const rec = await readyRecording(tenant.id);
    await storageTick(deps({ fetch: google.fn }));
    const [row] =
      await sql`select storage_status, storage_error, local_removed from recordings where id = ${rec.id}`;
    expect(row).toMatchObject({ storage_status: 'failed', local_removed: false });
    expect(row.storage_error).toMatch(/envio ao Google Drive falhou/);
    expect(existsSync(path.join(dir, rec.fileName))).toBe(true);
    // Without an encryption key or a recorder there is nothing to do.
    expect(await storageTick(deps({ key: null }))).toBe(0);
    expect(await storageTick(deps({ recordingsDir: null }))).toBe(0);
  });
});
