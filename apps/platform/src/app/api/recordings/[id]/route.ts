import { z } from 'zod';
import { db } from '@/server/db';
import { notFound } from '@/server/errors';
import { readerUser, writerUser } from '@/server/guard';
import { clientIp, handle, json } from '@/server/http';
import { recordingDeps } from '@/server/recordings/client';
import { openRecording, removeRecording } from '@/server/recordings/files';
import { deleteRecording, findVisibleRecording } from '@/server/recordings/service';

export const dynamic = 'force-dynamic';

const recordingId = z.string().uuid();

function installedDir(): string {
  const deps = recordingDeps();
  if (!deps) throw notFound('Gravação não encontrada');
  return deps.recordingsDir;
}

/** Downloads the MP4 (only for whoever may see the recording). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const user = await readerUser();
    const id = recordingId.safeParse((await params).id);
    if (!id.success) throw notFound('Gravação não encontrada');
    const rec = await findVisibleRecording(db(), user, id.data);
    if (rec.status !== 'ready') throw notFound('A gravação ainda não está pronta');
    const { body, size } = await openRecording(installedDir(), rec.fileName);
    const day = rec.startedAt.toISOString().slice(0, 10);
    const name = `${rec.roomName.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'reuniao'} ${day}.mp4`;
    return new Response(body, {
      headers: {
        'content-type': 'video/mp4',
        'content-length': String(size),
        'content-disposition': `attachment; filename="gravacao.mp4"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'cache-control': 'private, no-store',
      },
    });
  });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const user = await writerUser(req);
    const id = recordingId.safeParse((await params).id);
    if (!id.success) throw notFound('Gravação não encontrada');
    const dir = installedDir();
    await deleteRecording(db(), user, id.data, (file) => removeRecording(dir, file), clientIp(req));
    return json({ ok: true });
  });
}
