import { db } from '@/server/db';
import { readerUser } from '@/server/guard';
import { handle, json } from '@/server/http';
import { listTranscripts } from '@/server/transcripts/service';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return handle(async () => json({ transcripts: await listTranscripts(db(), await readerUser()) }));
}
