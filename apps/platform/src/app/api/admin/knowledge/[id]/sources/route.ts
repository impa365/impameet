import { z } from 'zod';
import { badRequest } from '@/server/errors';
import { readerUser, writerUser } from '@/server/guard';
import { clientIp, handle, json, readJson } from '@/server/http';
import { knowledgeDeps } from '@/server/knowledge/client';
import { MAX_FILE_BYTES, extractFile } from '@/server/knowledge/ingest';
import { addFile, addSource, listSources } from '@/server/knowledge/service';
import { knowledgeSourceInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

const id = z.string().uuid();
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const actor = await readerUser();
    return json({ sources: await listSources(knowledgeDeps(), actor, id.parse((await params).id)) });
  });
}

/** JSON for text, Q&A and links; multipart/form-data (field "file") for documents. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    const kbId = id.parse((await params).id);
    if ((req.headers.get('content-type') ?? '').includes('multipart/form-data')) {
      if (Number(req.headers.get('content-length') ?? 0) > MAX_FILE_BYTES + 64 * 1024)
        throw badRequest('Arquivo muito grande (máx. 50 MB)');
      const form = await req.formData().catch(() => null);
      const file = form?.get('file');
      if (!(file instanceof File)) throw badRequest('Envie um arquivo');
      const text = await extractFile(file.name, new Uint8Array(await file.arrayBuffer()));
      const { id: sourceId } = await addFile(
        knowledgeDeps(),
        actor,
        kbId,
        { name: file.name, text },
        clientIp(req),
      );
      return json({ id: sourceId }, 201);
    }
    const input = await readJson(req, knowledgeSourceInput, MAX_SOURCE_BYTES);
    const { ids } = await addSource(knowledgeDeps(), actor, kbId, input, clientIp(req));
    return json({ ids }, 201);
  });
}
