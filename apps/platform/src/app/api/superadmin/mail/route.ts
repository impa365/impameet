import { readerUser, writerUser } from '@/server/guard';
import { clientIp, handle, json, readJson } from '@/server/http';
import { mailDeps } from '@/server/mail/client';
import { getPlatformMail, savePlatformMail } from '@/server/mail/service';
import { platformSmtpInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

/** The platform's SMTP server, which organizations may choose to send through. */
export async function GET(): Promise<Response> {
  return handle(async () => json({ mail: await getPlatformMail(mailDeps(), await readerUser()) }));
}

export async function PUT(req: Request): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    const input = await readJson(req, platformSmtpInput);
    return json({ mail: await savePlatformMail(mailDeps(), actor, input, clientIp(req)) });
  });
}
