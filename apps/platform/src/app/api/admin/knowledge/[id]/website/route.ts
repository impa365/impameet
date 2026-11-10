import { z } from 'zod';
import { writerUser } from '@/server/guard';
import { clientIp, handle, json, readJson } from '@/server/http';
import { knowledgeDeps } from '@/server/knowledge/client';
import { addWebsite } from '@/server/knowledge/service';
import { knowledgeWebsiteInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

const id = z.string().uuid();

/** Imports the chosen pages of a website as one source (each page indexed on its own). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    const input = await readJson(req, knowledgeWebsiteInput, 512 * 1024);
    const { id: sourceId } = await addWebsite(
      knowledgeDeps(),
      actor,
      id.parse((await params).id),
      input,
      clientIp(req),
    );
    return json({ id: sourceId }, 201);
  });
}
