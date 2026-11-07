import { z } from 'zod';
import { agentForWorker } from '@/server/agents/service';
import { config } from '@/server/config';
import { db } from '@/server/db';
import { json } from '@/server/http';
import { internalAuthorized } from '@/server/internal';
import { parseMasterKey } from '@/server/security/secrets';

export const dynamic = 'force-dynamic';

/** The voice worker fetches the agent a room asked for (X-Internal-Token required). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const notFound = json({ error: { code: 'not_found', message: 'Not found' } }, 404);
  if (!internalAuthorized(req, config().internalToken)) return notFound;
  const id = z
    .string()
    .uuid()
    .safeParse((await params).id);
  if (!id.success) return notFound;
  // Includes the decrypted provider keys: only ever served on the internal network.
  const raw = config().encryptionKey;
  const agent = await agentForWorker(db(), raw ? parseMasterKey(raw) : null, id.data);
  return agent ? json({ agent }) : notFound;
}
