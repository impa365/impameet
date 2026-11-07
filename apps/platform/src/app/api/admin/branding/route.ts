import { updateBranding } from '@/server/admin/service';
import { db } from '@/server/db';
import { writerUser } from '@/server/guard';
import { clientIp, handle, json, readJson } from '@/server/http';
import { brandingInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

export async function PUT(req: Request): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    return json({
      branding: await updateBranding(db(), actor, await readJson(req, brandingInput), clientIp(req)),
    });
  });
}
