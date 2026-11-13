import { config } from '@/server/config';
import { writerUser } from '@/server/guard';
import { handle, json, readJson } from '@/server/http';
import { storageDeps } from '@/server/storage/client';
import { startDrive } from '@/server/storage/service';
import { driveStartInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

/** "Conectar com Google Drive": where to send the browser (Google's consent page). */
export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    const input = await readJson(req, driveStartInput);
    // Back to the page the admin is on (their organization's address), after Google.
    const host = (req.headers.get('host') ?? config().platformDomain).trim().toLowerCase();
    const returnUrl = `${config().secureCookies ? 'https' : 'http'}://${host}/admin?tab=storage`;
    return json(await startDrive(storageDeps(), actor, input, returnUrl));
  });
}
