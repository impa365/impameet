import { writerUser } from '@/server/guard';
import { handle, json } from '@/server/http';
import { storageDeps } from '@/server/storage/client';
import { testStorage } from '@/server/storage/service';

export const dynamic = 'force-dynamic';

/** Writes and deletes a tiny file in the configured storage. */
export async function POST(req: Request): Promise<Response> {
  return handle(async () => json(await testStorage(storageDeps(), await writerUser(req))));
}
