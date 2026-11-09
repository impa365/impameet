import { z } from 'zod';
import { config } from '@/server/config';
import { handle, json, readJson } from '@/server/http';
import { reportDeps } from '@/server/insights/client';
import { saveReport } from '@/server/insights/reports';
import { internalAuthorized } from '@/server/internal';
import { meetingReportInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

const agentId = z.string().uuid();
/** A long meeting's conversation: up to 20 000 lines. */
const MAX_REPORT_BYTES = 12 * 1024 * 1024;
const hidden = () => json({ error: { code: 'not_found', message: 'Not found' } }, 404);

/** The voice agent's report when it leaves a meeting; minutes are written in the background. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!internalAuthorized(req, config().internalToken)) return hidden();
  return handle(async () => {
    const id = agentId.parse((await params).id);
    const input = await readJson(req, meetingReportInput, MAX_REPORT_BYTES);
    const { id: reportId } = await saveReport(reportDeps(), id, input);
    return json({ id: reportId }, 201);
  });
}
