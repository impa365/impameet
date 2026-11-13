import { z } from 'zod';
import { notFound } from '@/server/errors';
import { writerUser } from '@/server/guard';
import { clientIp, handle, json } from '@/server/http';
import { liveDeps } from '@/server/live/client';
import { removeDestination } from '@/server/live/service';

export const dynamic = 'force-dynamic';

const destinationId = z.string().uuid();

/** Forgets a destination (a YouTube connection is also revoked at Google). */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    const id = destinationId.safeParse((await params).id);
    if (!id.success) throw notFound('Destino não encontrado');
    return json(await removeDestination(liveDeps(), actor, id.data, clientIp(req)));
  });
}
