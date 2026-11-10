import { z } from 'zod';
import { readerUser } from '@/server/guard';
import { handle } from '@/server/http';
import { knowledgeDeps } from '@/server/knowledge/client';
import { sourceText } from '@/server/knowledge/service';

export const dynamic = 'force-dynamic';

const id = z.string().uuid();

/** The text the agent reads from a source, as a Markdown download. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; sourceId: string }> },
): Promise<Response> {
  return handle(async () => {
    const actor = await readerUser();
    const p = await params;
    const { title, text } = await sourceText(knowledgeDeps(), actor, id.parse(p.id), id.parse(p.sourceId));
    const name =
      title
        .normalize('NFKD')
        .replace(/[^\w .-]+/g, '')
        .trim()
        .slice(0, 80) || 'fonte';
    return new Response(`# ${title}\n\n${text}\n`, {
      headers: {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="${name}.md"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  });
}
