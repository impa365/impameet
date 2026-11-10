import { writerUser } from '@/server/guard';
import { handle, json } from '@/server/http';
import { mailDeps } from '@/server/mail/client';
import { testPlatformMail } from '@/server/mail/service';

export const dynamic = 'force-dynamic';

/** Sends a test message through the platform's server to the super admin's own address. */
export async function POST(req: Request): Promise<Response> {
  return handle(async () => json(await testPlatformMail(mailDeps(), await writerUser(req))));
}
