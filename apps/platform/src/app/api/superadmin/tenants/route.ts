import { db } from '@/server/db';
import { readerUser } from '@/server/guard';
import { handle, json } from '@/server/http';
import { listTenants } from '@/server/superadmin/service';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return handle(async () => json({ tenants: await listTenants(db(), await readerUser()) }));
}
