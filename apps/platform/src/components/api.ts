'use client';

import { serverMessage } from '@/i18n/client';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** JSON request to this app's API; throws ApiError with the server's user-facing message. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: 'same-origin',
  });
  const data = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string } };
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data.error?.code ?? 'error',
      serverMessage(data.error?.message ?? 'Erro inesperado'),
    );
  }
  return data as T;
}
