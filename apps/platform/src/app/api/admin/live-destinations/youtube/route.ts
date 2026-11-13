import { config } from '@/server/config';
import { writerUser } from '@/server/guard';
import { handle, json, readJson } from '@/server/http';
import { liveDeps } from '@/server/live/client';
import { startYoutube } from '@/server/live/service';
import { youtubeStartInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

/** "Conectar YouTube": where to send the browser (Google's consent page). */
export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    const input = await readJson(req, youtubeStartInput);
    const host = (req.headers.get('host') ?? config().platformDomain).trim().toLowerCase();
    const returnUrl = `${config().secureCookies ? 'https' : 'http'}://${host}/admin?tab=streaming`;
    return json(await startYoutube(liveDeps(), actor, input, returnUrl));
  });
}
