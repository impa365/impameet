import { z } from 'zod';
import { db } from '@/server/db';
import { writerUser } from '@/server/guard';
import { clientIp, handle, json, readJson } from '@/server/http';
import { updateTenant } from '@/server/superadmin/service';
import { tenantAdminInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    const id = z
      .string()
      .uuid()
      .parse((await params).id);
    await updateTenant(db(), actor, id, await readJson(req, tenantAdminInput), clientIp(req));
    return json({ ok: true });
  });
}
