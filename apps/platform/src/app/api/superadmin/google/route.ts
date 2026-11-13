import { readerUser, writerUser } from '@/server/guard';
import { clientIp, handle, json, readJson } from '@/server/http';
import { storageDeps } from '@/server/storage/client';
import { getPlatformGoogle, savePlatformGoogle } from '@/server/storage/service';
import { platformGoogleInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

/** The platform's Google OAuth client (Drive and YouTube). The secret is never returned. */
export async function GET(): Promise<Response> {
  return handle(async () => json({ google: await getPlatformGoogle(storageDeps(), await readerUser()) }));
}

export async function PUT(req: Request): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    const input = await readJson(req, platformGoogleInput);
    return json({ google: await savePlatformGoogle(storageDeps(), actor, input, clientIp(req)) });
  });
}
