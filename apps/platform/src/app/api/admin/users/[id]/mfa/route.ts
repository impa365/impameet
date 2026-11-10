import { z } from 'zod';
import { resetUserMfa } from '@/server/auth/mfa';
import { mfaDeps } from '@/server/mfa-client';
import { writerUser } from '@/server/guard';
import { clientIp, handle, json } from '@/server/http';

export const dynamic = 'force-dynamic';

const id = z.string().uuid();

/** Clears someone's verification methods (a lost phone) and signs them out everywhere. */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    await resetUserMfa(mfaDeps(), actor, id.parse((await params).id), clientIp(req));
    return json({ ok: true });
  });
}
