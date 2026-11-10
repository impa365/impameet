import { getLocale } from '@/i18n/server';
import { config } from '@/server/config';
import { db } from '@/server/db';
import { notFound } from '@/server/errors';
import { readerUser, writerUser } from '@/server/guard';
import { clientIp, handle, json, readJson } from '@/server/http';
import { inviteText } from '@/server/meetings/ics';
import { inviteEvent, inviteMail, roomUrl } from '@/server/meetings/invite';
import { mailDeps } from '@/server/mail/client';
import { tenantMailer } from '@/server/mail/service';
import { sendInvites } from '@/server/meetings/mailer';
import { createMeeting, listMeetings } from '@/server/meetings/service';
import { currentTenant } from '@/server/request';
import { meetingInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return handle(async () => {
    const user = await readerUser();
    const meetings = await listMeetings(db(), user);
    const secure = config().secureCookies;
    return json({
      mailEnabled: (await tenantMailer(mailDeps(), user.tenantId)) !== null,
      meetings: meetings.map((m) => ({ ...m, url: roomUrl(req, m.roomSlug, secure) })),
    });
  });
}

/** Schedules a meeting; with SMTP configured, e-mails each invitee a calendar invite. */
export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const user = await writerUser(req);
    const ctx = await currentTenant();
    if (!ctx) throw notFound('Organização não encontrada');
    const meeting = await createMeeting(db(), user, await readJson(req, meetingInput), clientIp(req));
    const url = roomUrl(req, meeting.roomSlug, config().secureCookies);
    const event = inviteEvent(meeting, url, ctx.branding.productName, await getLocale());
    const mailer = await tenantMailer(mailDeps(), ctx.tenant.id);
    const mail = mailer
      ? await sendInvites(mailer, meeting.invitees, (to) => inviteMail(event, to))
      : { sent: 0, failed: 0 };
    return json({ meeting: { ...meeting, url }, inviteText: inviteText(event), mail }, 201);
  });
}
