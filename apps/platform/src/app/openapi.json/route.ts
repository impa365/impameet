import { buildOpenApi } from '@/server/api-v1/openapi';

export const dynamic = 'force-dynamic';

function publicOrigin(req: Request): string {
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  const proto = req.headers.get('x-forwarded-proto') ?? 'https';
  if (host) return `${proto}://${host}`;
  return new URL(req.url).origin;
}

export async function GET(req: Request): Promise<Response> {
  return Response.json(buildOpenApi(publicOrigin(req)), {
    headers: {
      'cache-control': 'public, max-age=60',
      'access-control-allow-origin': '*',
    },
  });
}
