import { readerUser, writerUser } from '@/server/guard';
import { clientIp, handle, json, readJson } from '@/server/http';
import { mailDeps } from '@/server/mail/client';
import { getTenantMail, saveTenantMail } from '@/server/mail/service';
import { tenantSmtpInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

/** How this organization sends e-mail (the password is never returned). */
export async function GET(): Promise<Response> {
  return handle(async () => json({ mail: await getTenantMail(mailDeps(), await readerUser()) }));
}

export async function PUT(req: Request): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    const input = await readJson(req, tenantSmtpInput);
    return json({ mail: await saveTenantMail(mailDeps(), actor, input, clientIp(req)) });
  });
}
