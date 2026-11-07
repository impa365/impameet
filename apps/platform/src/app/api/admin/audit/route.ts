import { listAudit } from '@/server/admin/service';
import { db } from '@/server/db';
import { readerUser } from '@/server/guard';
import { handle, json } from '@/server/http';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return handle(async () => json({ entries: await listAudit(db(), await readerUser()) }));
}
