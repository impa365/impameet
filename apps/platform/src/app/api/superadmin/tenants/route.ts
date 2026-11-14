import { db } from '@/server/db';
import { readerUser } from '@/server/guard';
import { handle, json } from '@/server/http';
import { PLAN_LIMITS } from '@/server/plans';
import { listTenants } from '@/server/superadmin/service';

export const dynamic = 'force-dynamic';

/** Every organization, and what each plan allows by default (the form shows what was changed). */
export async function GET(): Promise<Response> {
  return handle(async () =>
    json({ tenants: await listTenants(db(), await readerUser()), plans: PLAN_LIMITS }),
  );
}
