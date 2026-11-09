import { z } from 'zod';
import { db } from '@/server/db';
import { notFound } from '@/server/errors';
import { readerUser, writerUser } from '@/server/guard';
import { clientIp, handle, json } from '@/server/http';
import { deleteReport, findReport, minutesText } from '@/server/insights/reports';

export const dynamic = 'force-dynamic';

const reportId = z.string().uuid();

async function idOf(params: Promise<{ id: string }>): Promise<string> {
  const id = reportId.safeParse((await params).id);
  if (!id.success) throw notFound('Ata não encontrada');
  return id.data;
}

/** The report as JSON, or `?format=text` to download the minutes. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const report = await findReport(db(), await readerUser(), await idOf(params));
    if (new URL(req.url).searchParams.get('format') !== 'text') return json({ report });
    const name = `Ata ${report.roomName.replace(/[^\p{L}\p{N} _-]/gu, '').trim()} ${new Date(report.startedAt).toISOString().slice(0, 10)}.txt`;
    return new Response(minutesText(report), {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': `attachment; filename="ata.txt"; filename*=UTF-8''${encodeURIComponent(name)}`,
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
    await deleteReport(db(), user, await idOf(params), clientIp(req));
    return json({ ok: true });
  });
}
