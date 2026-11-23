import { buildOpenApi } from '@/server/api-v1/openapi';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const origin = new URL(req.url).origin;
  return Response.json(buildOpenApi(origin), {
    headers: {
      'cache-control': 'public, max-age=60',
      'access-control-allow-origin': '*',
    },
  });
}
