import { db } from '@/server/db';
import { writerUser } from '@/server/guard';
import { clientIp, handle, json } from '@/server/http';
import { revokeSuperadmin } from '@/server/superadmin/grants';

export const dynamic = 'force-dynamic';

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ userId: string }> },
): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    const { userId } = await params;
    await revokeSuperadmin(db(), actor, userId, clientIp(req));
    return json({ ok: true });
  });
}
