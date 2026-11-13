import { db } from '@/server/db';
import { clientIp, handle } from '@/server/http';
import { liveDeps } from '@/server/live/client';
import { finishYoutube } from '@/server/live/service';
import { storageDeps } from '@/server/storage/client';
import { finishDrive, oauthPurpose } from '@/server/storage/service';

export const dynamic = 'force-dynamic';

/**
 * Google's redirect after "Conectar com Google" (Drive) or "Conectar YouTube". Always on the
 * platform's own address (the one registered in the Google Cloud Console); the one-time state
 * says what was being connected, which organization and admin started it, and where to go back.
 */
export async function GET(req: Request): Promise<Response> {
  return handle(async () => {
    const url = new URL(req.url);
    const params = {
      state: url.searchParams.get('state'),
      code: url.searchParams.get('code'),
      error: url.searchParams.get('error'),
    };
    const back =
      (await oauthPurpose(db(), params.state)) === 'youtube'
        ? await finishYoutube(liveDeps(), params, clientIp(req))
        : await finishDrive(storageDeps(), params, clientIp(req));
    return new Response(null, {
      status: 303,
      headers: { location: back, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
    });
  });
}
