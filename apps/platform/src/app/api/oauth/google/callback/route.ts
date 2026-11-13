import { clientIp, handle } from '@/server/http';
import { storageDeps } from '@/server/storage/client';
import { finishDrive } from '@/server/storage/service';

export const dynamic = 'force-dynamic';

/**
 * Google's redirect after "Conectar com Google". Always on the platform's own address (the one
 * registered in the Google Cloud Console); the one-time state says which organization and admin
 * started it, and where to send them back.
 */
export async function GET(req: Request): Promise<Response> {
  return handle(async () => {
    const url = new URL(req.url);
    const back = await finishDrive(
      storageDeps(),
      {
        state: url.searchParams.get('state'),
        code: url.searchParams.get('code'),
        error: url.searchParams.get('error'),
      },
      clientIp(req),
    );
    return new Response(null, {
      status: 303,
      headers: { location: back, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
    });
  });
}
