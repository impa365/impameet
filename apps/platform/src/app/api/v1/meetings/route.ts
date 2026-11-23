import { requireApiUser, auditV1 } from '@/server/api-v1/auth';
import { handle, json, readJson } from '@/server/http';
import { createMeeting, listMeetings } from '@/server/meetings/service';
import { meetingInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return handle(async () => {
    const ctx = await requireApiUser(req);
    const res = json({ meetings: await listMeetings(ctx.sql, ctx.user) });
    auditV1(req, ctx, res.status);
    return res;
  });
}

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const ctx = await requireApiUser(req);
    const meeting = await createMeeting(ctx.sql, ctx.user, await readJson(req, meetingInput), ctx.ip);
    const res = json({ meeting }, 201);
    auditV1(req, ctx, res.status);
    return res;
  });
}
