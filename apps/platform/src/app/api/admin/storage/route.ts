import { readerUser, writerUser } from '@/server/guard';
import { clientIp, handle, json, readJson } from '@/server/http';
import { storageDeps } from '@/server/storage/client';
import { getStorage, removeStorage, saveS3, setKeepLocal } from '@/server/storage/service';
import { keepLocalInput, s3StorageInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

/** Where the organization's recordings go (credentials are never returned). */
export async function GET(): Promise<Response> {
  return handle(async () => json(await getStorage(storageDeps(), await readerUser())));
}

/** S3 or compatible: saved only after a real test write works. */
export async function PUT(req: Request): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    const input = await readJson(req, s3StorageInput);
    return json(await saveS3(storageDeps(), actor, input, clientIp(req)));
  });
}

export async function PATCH(req: Request): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    const input = await readJson(req, keepLocalInput);
    return json(await setKeepLocal(storageDeps(), actor, input, clientIp(req)));
  });
}

/** Back to the server only (a Google connection is also revoked at Google). */
export async function DELETE(req: Request): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    await removeStorage(storageDeps(), actor, clientIp(req));
    return json({ ok: true });
  });
}
