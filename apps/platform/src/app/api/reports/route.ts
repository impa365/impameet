import { db } from '@/server/db';
import { readerUser } from '@/server/guard';
import { handle, json } from '@/server/http';
import { listReports } from '@/server/insights/reports';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return handle(async () => json({ reports: await listReports(db(), await readerUser()) }));
}
