import { z } from 'zod';
import { tooManyRequests } from '@/server/errors';
import { writerUser } from '@/server/guard';
import { handle, json } from '@/server/http';
import { integrationDeps } from '@/server/integrations/client';
import { testIntegration } from '@/server/integrations/service';
import { limits } from '@/server/limits';

export const dynamic = 'force-dynamic';

/** "Testar conexão": checks the saved key against the provider and lists its models. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    if (!limits.moderationPerUser.take(`probe:${actor.id}`)) throw tooManyRequests();
    return json(
      await testIntegration(
        integrationDeps(),
        actor,
        z
          .string()
          .uuid()
          .parse((await params).id),
      ),
    );
  });
}
