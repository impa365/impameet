import { z } from 'zod';
import { revokeApiKey } from '@/server/api-keys/service';
import { db } from '@/server/db';
import { writerUser } from '@/server/guard';
import { handle, json } from '@/server/http';

export const dynamic = 'force-dynamic';

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const user = await writerUser(req);
    await revokeApiKey(
      db(),
      user.email,
      z
        .string()
        .uuid()
        .parse((await params).id),
    );
    return json({ ok: true });
  });
}
