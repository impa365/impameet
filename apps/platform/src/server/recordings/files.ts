import { createReadStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { notFound } from '../errors';

/**
 * `<tenant uuid>_<recording uuid>.mp4`, the only shape the platform ever writes. Flat on
 * purpose: Egress would create sub-directories the platform could not delete from.
 */
const FILE_NAME = /^[0-9a-f-]{36}_[0-9a-f-]{36}\.mp4$/;

export function recordingFileName(tenantId: string, recordingId: string): string {
  return `${tenantId}_${recordingId}.mp4`;
}

export function recordingPath(dir: string, fileName: string): string {
  if (!FILE_NAME.test(fileName)) throw notFound('Gravação não encontrada');
  return path.join(dir, fileName);
}

export async function openRecording(
  dir: string,
  fileName: string,
): Promise<{ body: ReadableStream<Uint8Array>; size: number }> {
  const file = recordingPath(dir, fileName);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw notFound('O arquivo da gravação não está disponível');
  const body = Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>;
  return { body, size: info.size };
}

export async function removeRecording(dir: string, fileName: string): Promise<void> {
  await rm(recordingPath(dir, fileName), { force: true });
}
