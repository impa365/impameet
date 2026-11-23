import { handleMcpPost } from '@/server/api-v1/mcp-server';
import { handle, json } from '@/server/http';

export const dynamic = 'force-dynamic';

/** MCP Streamable HTTP endpoint — same API keys as /api/v1. */
export async function POST(req: Request): Promise<Response> {
  return handle(() => handleMcpPost(req));
}

export async function GET(req: Request): Promise<Response> {
  const origin = new URL(req.url).origin;
  return json({
    name: 'impameet',
    transport: 'streamable-http',
    auth: 'Authorization: Bearer impa_…',
    orgHeader: 'X-Impa-Org: <tenant-uuid>',
    docs: `${origin}/developers`,
    openapi: `${origin}/openapi.json`,
    llms: `${origin}/llms.txt`,
    llmsFull: `${origin}/llms-full.txt`,
  });
}
