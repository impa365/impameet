import { disconnectCalendar, getCalendar, startCalendar } from '@/server/calendar/service';
import { config } from '@/server/config';
import { readerUser, writerUser } from '@/server/guard';
import { clientIp, handle, json } from '@/server/http';
import { storageDeps } from '@/server/storage/client';

export const dynamic = 'force-dynamic';

/** The person's own Google Calendar connection (never the token). */
export async function GET(): Promise<Response> {
  return handle(async () => json({ calendar: await getCalendar(storageDeps(), await readerUser()) }));
}

/** "Conectar Google Agenda": where to send the browser (Google's consent page). */
export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const user = await writerUser(req);
    const host = (req.headers.get('host') ?? config().platformDomain).trim().toLowerCase();
    const returnUrl = `${config().secureCookies ? 'https' : 'http'}://${host}/account`;
    return json(await startCalendar(storageDeps(), user, returnUrl));
  });
}

/** Disconnects (the access is revoked at Google too). */
export async function DELETE(req: Request): Promise<Response> {
  return handle(async () => {
    const user = await writerUser(req);
    await disconnectCalendar(storageDeps(), user, clientIp(req));
    return json({ ok: true });
  });
}
