import { db } from '@/server/db';
import { readerUser, writerUser } from '@/server/guard';
import { clientIp, handle, json, readJson } from '@/server/http';
import { integrationDeps } from '@/server/integrations/client';
import { createIntegration, listIntegrations } from '@/server/integrations/service';
import { config } from '@/server/config';
import { integrationInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

/** Keys are never returned: only a hint with the last 4 characters. */
export async function GET(): Promise<Response> {
  return handle(async () =>
    json({
      enabled: Boolean(config().encryptionKey),
      integrations: await listIntegrations(db(), await readerUser()),
    }),
  );
}

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    const input = await readJson(req, integrationInput);
    return json(
      { integration: await createIntegration(integrationDeps(), actor, input, clientIp(req)) },
      201,
    );
  });
}
