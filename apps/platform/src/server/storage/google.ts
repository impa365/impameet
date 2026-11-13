/**
 * Google OAuth 2.0 (authorization code + PKCE) and the Drive calls the recordings need, over
 * plain fetch. Only the `drive.file` scope is asked: the platform sees nothing in the person's
 * Drive except the folder and files it created itself.
 */
import { createHash, randomBytes } from 'node:crypto';

export type Fetch = typeof fetch;

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const DRIVE_URL = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3';
export const DRIVE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/drive.file'];
const TIMEOUT_MS = 20_000;

export class GoogleError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export const base64url = (b: Buffer) => b.toString('base64url');

/** A fresh state and PKCE pair for one "Conectar com Google". */
export function oauthStart(): { state: string; verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(48));
  return {
    state: base64url(randomBytes(32)),
    verifier,
    challenge: base64url(createHash('sha256').update(verifier).digest()),
  };
}

export function authUrl(client: GoogleClient, state: string, challenge: string, scopes: string[]): string {
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    // A refresh token, every time (the previous one is replaced): uploads happen later.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
  });
  return `${GOOGLE_AUTH_URL}?${params}`;
}

async function call(fetchImpl: Fetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
  } catch {
    throw new GoogleError('Não foi possível falar com o Google agora');
  }
}

async function failure(res: Response, what: string): Promise<GoogleError> {
  const body = (await res.json().catch(() => null)) as {
    error?: string | { message?: string; status?: string };
    error_description?: string;
  } | null;
  const detail =
    typeof body?.error === 'string'
      ? (body.error_description ?? body.error)
      : (body?.error?.status ?? body?.error?.message ?? `HTTP ${res.status}`);
  return new GoogleError(`${what}: ${String(detail).slice(0, 200)}`, res.status);
}

/** The e-mail in an ID token received straight from Google's token endpoint over TLS. */
function emailOf(idToken: unknown): string | null {
  if (typeof idToken !== 'string') return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
      email?: unknown;
      email_verified?: unknown;
    };
    return typeof payload.email === 'string' && payload.email_verified !== false ? payload.email : null;
  } catch {
    return null;
  }
}

/** Exchanges the code Google sent back (with the PKCE verifier) for a refresh token. */
export async function exchangeCode(
  fetchImpl: Fetch,
  client: GoogleClient,
  code: string,
  verifier: string,
): Promise<{ refreshToken: string; accessToken: string; email: string | null; scopes: string[] }> {
  const res = await call(fetchImpl, GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: client.redirectUri,
    }),
  });
  if (!res.ok) throw await failure(res, 'O Google recusou a conexão');
  const body = (await res.json()) as {
    refresh_token?: string;
    access_token?: string;
    id_token?: string;
    scope?: string;
  };
  if (!body.refresh_token || !body.access_token)
    throw new GoogleError('O Google não devolveu o acesso permanente');
  return {
    refreshToken: body.refresh_token,
    accessToken: body.access_token,
    email: emailOf(body.id_token),
    scopes: (body.scope ?? '').split(' ').filter(Boolean),
  };
}

/** A short-lived access token from the stored refresh token. */
export async function accessToken(
  fetchImpl: Fetch,
  client: Omit<GoogleClient, 'redirectUri'>,
  refreshToken: string,
) {
  const res = await call(fetchImpl, GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    }),
  });
  if (!res.ok) throw await failure(res, 'O acesso ao Google expirou ou foi revogado; conecte de novo');
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new GoogleError('O Google não devolveu um acesso');
  return body.access_token;
}

/** Tells Google to forget the platform's access (best effort: the token is deleted anyway). */
export async function revoke(fetchImpl: Fetch, token: string): Promise<void> {
  await call(fetchImpl, GOOGLE_REVOKE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
  }).catch(() => undefined);
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** The folder the recordings go to (created by the platform, so `drive.file` can use it). */
export async function createFolder(fetchImpl: Fetch, token: string, name: string): Promise<string> {
  const res = await call(fetchImpl, `${DRIVE_URL}/files?fields=id`, {
    method: 'POST',
    headers: { ...auth(token), 'content-type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' }),
  });
  if (!res.ok) throw await failure(res, 'Não foi possível criar a pasta no Google Drive');
  const body = (await res.json()) as { id?: string };
  if (!body.id) throw new GoogleError('O Google Drive não devolveu a pasta');
  return body.id;
}

/** Proves the folder is still there and writable (a tiny file, then deleted). */
export async function testFolder(fetchImpl: Fetch, token: string, folderId: string): Promise<void> {
  const res = await call(fetchImpl, `${DRIVE_UPLOAD_URL}/files?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: { ...auth(token), 'content-type': 'multipart/related; boundary=impa' },
    body: [
      '--impa',
      'content-type: application/json; charset=UTF-8',
      '',
      JSON.stringify({ name: 'impa-meet-teste.txt', parents: [folderId] }),
      '--impa',
      'content-type: text/plain',
      '',
      'IMPA Meet: teste de gravação no Google Drive.',
      '--impa--',
    ].join('\r\n'),
  });
  if (!res.ok) throw await failure(res, 'Não foi possível escrever na pasta do Google Drive');
  const { id } = (await res.json()) as { id?: string };
  if (id)
    await call(fetchImpl, `${DRIVE_URL}/files/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: auth(token),
    });
}

/**
 * Uploads a recording in one resumable session (the file streams from disk, never whole in
 * memory). Returns the Drive file id and the link to open it.
 */
export async function uploadFile(
  fetchImpl: Fetch,
  token: string,
  folderId: string,
  name: string,
  size: number,
  body: ReadableStream<Uint8Array>,
): Promise<{ id: string; link: string | null }> {
  const start = await call(
    fetchImpl,
    `${DRIVE_UPLOAD_URL}/files?uploadType=resumable&fields=id,webViewLink`,
    {
      method: 'POST',
      headers: {
        ...auth(token),
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-type': 'video/mp4',
        'x-upload-content-length': String(size),
      },
      body: JSON.stringify({ name, parents: [folderId], mimeType: 'video/mp4' }),
    },
  );
  if (!start.ok) throw await failure(start, 'O Google Drive recusou o envio');
  const session = start.headers.get('location');
  if (!session?.startsWith(DRIVE_UPLOAD_URL)) throw new GoogleError('O Google Drive não abriu o envio');
  const res = await call(fetchImpl, session, {
    method: 'PUT',
    headers: { 'content-type': 'video/mp4', 'content-length': String(size) },
    body,
    // Long files: no short deadline here, the stream keeps it alive.
    signal: AbortSignal.timeout(6 * 60 * 60_000),
    duplex: 'half',
  } as RequestInit);
  if (!res.ok) throw await failure(res, 'O envio ao Google Drive falhou');
  const file = (await res.json()) as { id?: string; webViewLink?: string };
  if (!file.id) throw new GoogleError('O Google Drive não devolveu o arquivo');
  return { id: file.id, link: file.webViewLink ?? null };
}

/** The file's content, to serve the download through the platform (permissions stay ours). */
export async function downloadFile(fetchImpl: Fetch, token: string, fileId: string): Promise<Response> {
  const res = await call(fetchImpl, `${DRIVE_URL}/files/${encodeURIComponent(fileId)}?alt=media`, {
    headers: auth(token),
    signal: AbortSignal.timeout(6 * 60 * 60_000),
  });
  if (!res.ok) throw await failure(res, 'Não foi possível baixar do Google Drive');
  return res;
}
