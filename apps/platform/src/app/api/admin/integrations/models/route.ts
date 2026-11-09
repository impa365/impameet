import { tooManyRequests } from '@/server/errors';
import { writerUser } from '@/server/guard';
import { handle, json, readJson } from '@/server/http';
import { integrationDeps } from '@/server/integrations/client';
import { discoverModels } from '@/server/integrations/service';
import { limits } from '@/server/limits';
import { modelDiscoveryInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

/** "Buscar modelos": lists what the typed (or saved) key can use, before saving the form. */
export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    if (!limits.moderationPerUser.take(`probe:${actor.id}`)) throw tooManyRequests();
    const input = await readJson(req, modelDiscoveryInput);
    return json(await discoverModels(integrationDeps(), actor, input));
  });
}
