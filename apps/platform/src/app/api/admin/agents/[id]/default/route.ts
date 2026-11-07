import { z } from 'zod';
import { setDefaultAgent } from '@/server/agents/service';
import { db } from '@/server/db';
import { writerUser } from '@/server/guard';
import { clientIp, handle, json } from '@/server/http';

export const dynamic = 'force-dynamic';

/** Makes this the organization's default agent (used by rooms that do not pick one). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    await setDefaultAgent(
      db(),
      actor,
      z
        .string()
        .uuid()
        .parse((await params).id),
      clientIp(req),
    );
    return json({ ok: true });
  });
}
