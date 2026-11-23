import { z } from 'zod';
import { createApiKey, listApiKeys } from '@/server/api-keys/service';
import { ORG_PERMISSIONS } from '@/server/rbac/permissions';
import { readerUser, writerUser } from '@/server/guard';
import { handle, json, readJson } from '@/server/http';
import { db } from '@/server/db';

export const dynamic = 'force-dynamic';

const orgPerm = z.enum(ORG_PERMISSIONS as unknown as [string, ...string[]]);

const createKeyInput = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(orgPerm).max(ORG_PERMISSIONS.length).optional(),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
});

/** Session-authenticated: manage API keys for the signed-in person (by email). */
export async function GET(): Promise<Response> {
  return handle(async () => {
    const user = await readerUser();
    return json({ keys: await listApiKeys(db(), user.email) });
  });
}

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const user = await writerUser(req);
    const key = await createApiKey(db(), user, await readJson(req, createKeyInput));
    return json({ key }, 201);
  });
}
