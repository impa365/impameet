import { z } from 'zod';
import { createExample, listExamples } from '@/server/agents/examples';
import { db } from '@/server/db';
import { readerUser, writerUser } from '@/server/guard';
import { clientIp, handle, json, readJson } from '@/server/http';
import { agentExampleInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

const id = z.string().uuid();

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () =>
    json({ examples: await listExamples(db(), await readerUser(), id.parse((await params).id)) }),
  );
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    const input = await readJson(req, agentExampleInput);
    return json(
      { example: await createExample(db(), actor, id.parse((await params).id), input, clientIp(req)) },
      201,
    );
  });
}
