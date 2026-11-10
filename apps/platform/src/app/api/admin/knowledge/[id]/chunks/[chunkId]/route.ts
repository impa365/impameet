import { z } from 'zod';
import { writerUser } from '@/server/guard';
import { handle, json, readJson } from '@/server/http';
import { knowledgeDeps } from '@/server/knowledge/client';
import { updateChunk } from '@/server/knowledge/service';
import { knowledgeChunkPatch } from '@/server/validation';

export const dynamic = 'force-dynamic';

const id = z.string().uuid();

/** Turn one piece off (the agent stops finding it) or correct its text. */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; chunkId: string }> },
): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    const p = await params;
    const input = await readJson(req, knowledgeChunkPatch);
    return json({
      chunk: await updateChunk(knowledgeDeps(), actor, id.parse(p.id), id.parse(p.chunkId), input),
    });
  });
}
