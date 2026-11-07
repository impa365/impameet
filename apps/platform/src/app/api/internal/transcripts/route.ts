import { config } from '@/server/config';
import { db } from '@/server/db';
import { handle, json, readJson } from '@/server/http';
import { internalAuthorized } from '@/server/internal';
import { saveTranscript, transcriptInput } from '@/server/transcripts/service';

export const dynamic = 'force-dynamic';

const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

/** The captions worker hands over the meeting transcript when it leaves (X-Internal-Token). */
export async function POST(req: Request): Promise<Response> {
  if (!internalAuthorized(req, config().internalToken)) {
    return json({ error: { code: 'not_found', message: 'Not found' } }, 404);
  }
  return handle(async () => {
    const input = await readJson(req, transcriptInput, MAX_TRANSCRIPT_BYTES);
    return json({ id: await saveTranscript(db(), input) }, 201);
  });
}
