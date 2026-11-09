import { z } from 'zod';
import { tooManyRequests } from '@/server/errors';
import { writerUser } from '@/server/guard';
import { handle, json, readJson } from '@/server/http';
import { integrationDeps } from '@/server/integrations/client';
import { listVoices } from '@/server/integrations/service';
import { limits } from '@/server/limits';
import { voiceSearchInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

/** "Escolher voz": the voices of a saved speech key, with samples to listen to. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    if (!limits.moderationPerUser.take(`probe:${actor.id}`)) throw tooManyRequests();
    const id = z
      .string()
      .uuid()
      .parse((await params).id);
    const query = await readJson(req, voiceSearchInput);
    return json(await listVoices(integrationDeps(), actor, id, query));
  });
}
