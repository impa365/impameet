import { db } from '@/server/db';
import { readerUser } from '@/server/guard';
import { handle, json } from '@/server/http';
import { searchUsersForGrant } from '@/server/superadmin/grants';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return handle(async () => {
    const q = new URL(req.url).searchParams.get('q') ?? '';
    return json(await searchUsersForGrant(db(), await readerUser(), q));
  });
}
