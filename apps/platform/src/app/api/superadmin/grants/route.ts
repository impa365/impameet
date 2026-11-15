import { db } from '@/server/db';
import { readerUser, writerUser } from '@/server/guard';
import { clientIp, handle, json, readJson } from '@/server/http';
import { grantSuperadmin, listSuperadmins } from '@/server/superadmin/grants';
import { superadminGrantInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return handle(async () => json(await listSuperadmins(db(), await readerUser())));
}

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    const { userId } = await readJson(req, superadminGrantInput);
    await grantSuperadmin(db(), actor, userId, clientIp(req));
    return json({ ok: true }, 201);
  });
}
