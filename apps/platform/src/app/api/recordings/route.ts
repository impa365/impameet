import { readerUser } from '@/server/guard';
import { handle, json } from '@/server/http';
import { recordingDeps } from '@/server/recordings/client';
import { listRecordings } from '@/server/recordings/service';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return handle(async () => {
    const user = await readerUser();
    const deps = recordingDeps();
    return json({ installed: deps !== null, recordings: deps ? await listRecordings(deps, user) : [] });
  });
}
