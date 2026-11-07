import { cookies } from 'next/headers';
import { SESSION_COOKIE, deleteSession } from '@/server/auth/session';
import { config } from '@/server/config';
import { db } from '@/server/db';
import { assertSameOrigin, clearedCookie, handle, json } from '@/server/http';

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    assertSameOrigin(req);
    await deleteSession(db(), (await cookies()).get(SESSION_COOKIE)?.value);
    return json({ ok: true }, 200, { 'set-cookie': clearedCookie(SESSION_COOKIE, config().secureCookies) });
  });
}
