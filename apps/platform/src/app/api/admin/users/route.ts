import { db } from '@/server/db';
import { readerUser, writerUser } from '@/server/guard';
import { clientIp, handle, json, readJson } from '@/server/http';
import { createUser, listUsers } from '@/server/users/service';
import { createUserInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return handle(async () => json({ users: await listUsers(db(), await readerUser()) }));
}

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    const user = await createUser(db(), actor, await readJson(req, createUserInput), clientIp(req));
    return json({ user }, 201);
  });
}
