import { writerUser } from '@/server/guard';
import { handle, json } from '@/server/http';
import { mailDeps } from '@/server/mail/client';
import { testTenantMail } from '@/server/mail/service';

export const dynamic = 'force-dynamic';

/** Sends a test message to the signed-in admin's own address. */
export async function POST(req: Request): Promise<Response> {
  return handle(async () => json(await testTenantMail(mailDeps(), await writerUser(req))));
}
