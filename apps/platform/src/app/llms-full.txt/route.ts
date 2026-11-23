import { buildLlmsFullTxt } from '@/server/api-v1/llms';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const origin = new URL(req.url).origin;
  return new Response(buildLlmsFullTxt(origin), {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=60',
      'access-control-allow-origin': '*',
    },
  });
}
