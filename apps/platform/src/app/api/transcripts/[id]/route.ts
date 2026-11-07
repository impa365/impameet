import { z } from 'zod';
import { db } from '@/server/db';
import { notFound } from '@/server/errors';
import { readerUser, writerUser } from '@/server/guard';
import { clientIp, handle, json } from '@/server/http';
import { deleteTranscript, transcriptText } from '@/server/transcripts/service';

export const dynamic = 'force-dynamic';

const transcriptId = z.string().uuid();

async function idOf(params: Promise<{ id: string }>): Promise<string> {
  const id = transcriptId.safeParse((await params).id);
  if (!id.success) throw notFound('Transcrição não encontrada');
  return id.data;
}

/** Plain-text download: `[hh:mm:ss] Nome: fala` per line. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const user = await readerUser();
    const { roomName, startedAt, text } = await transcriptText(db(), user, await idOf(params));
    const name = `Transcrição ${roomName.replace(/[^\p{L}\p{N} _-]/gu, '').trim()} ${startedAt.toISOString().slice(0, 10)}.txt`;
    return new Response(text, {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': `attachment; filename="transcricao.txt"; filename*=UTF-8''${encodeURIComponent(name)}`,
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
    await deleteTranscript(db(), user, await idOf(params), clientIp(req));
    return json({ ok: true });
  });
}
