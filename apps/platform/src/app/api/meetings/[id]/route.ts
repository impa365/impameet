import { z } from 'zod';
import { getLocale } from '@/i18n/server';
import { config } from '@/server/config';
import { db } from '@/server/db';
import { notFound } from '@/server/errors';
import { readerUser, writerUser } from '@/server/guard';
import { clientIp, handle, json } from '@/server/http';
import { buildIcs } from '@/server/meetings/ics';
import { inviteEvent, roomUrl } from '@/server/meetings/invite';
import { cancelMeeting, findVisibleMeeting } from '@/server/meetings/service';
import { currentTenant } from '@/server/request';
import { removeMeetingEvent } from '@/server/calendar/service';
import { storageDeps } from '@/server/storage/client';

export const dynamic = 'force-dynamic';

async function idOf(params: Promise<{ id: string }>): Promise<string> {
  const id = z
    .string()
    .uuid()
    .safeParse((await params).id);
  if (!id.success) throw notFound('Reunião não encontrada');
  return id.data;
}

/** The calendar invite (.ics) of a scheduled meeting. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const user = await readerUser();
    const ctx = await currentTenant();
    if (!ctx) throw notFound('Organização não encontrada');
    const meeting = await findVisibleMeeting(db(), user, await idOf(params));
    const url = roomUrl(req, meeting.roomSlug, config().secureCookies);
    return new Response(buildIcs(inviteEvent(meeting, url, ctx.branding.productName, await getLocale())), {
      headers: {
        'content-type': 'text/calendar; charset=utf-8; method=REQUEST',
        'content-disposition': 'attachment; filename="convite.ics"',
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
    const link = await cancelMeeting(db(), user, await idOf(params), clientIp(req));
    return json({ ok: true, googleCancelled: await removeMeetingEvent(storageDeps(), link) });
  });
}
