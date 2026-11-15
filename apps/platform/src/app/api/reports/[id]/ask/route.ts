import { z } from 'zod';
import { reportDeps } from '@/server/insights/client';
import { askAboutReport } from '@/server/insights/reports';
import { notFound, tooManyRequests } from '@/server/errors';
import { writerUser } from '@/server/guard';
import { assertSameOrigin, handle, json, readJson } from '@/server/http';
import { limits } from '@/server/limits';
import { reportAskInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

const reportId = z.string().uuid();

/** Ask a question about a finished meeting (ata + workspace + transcript). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(req);
    const user = await writerUser(req);
    if (!limits.writePerUser.take(`report-ask:${user.id}`)) throw tooManyRequests();
    const id = reportId.safeParse((await params).id);
    if (!id.success) throw notFound('Ata não encontrada');
    const { question } = await readJson(req, reportAskInput);
    return json(await askAboutReport(reportDeps(), user, id.data, question));
  });
}
