import { db } from '@/server/db';
import { readerUser, writerUser } from '@/server/guard';
import { clientIp, handle, json, readJson } from '@/server/http';
import { hasPermission } from '@/server/rbac/service';
import { createUser, listAssignableRoles, listUsers } from '@/server/users/service';
import { createUserInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return handle(async () => {
    const actor = await readerUser();
    const users = await listUsers(db(), actor);
    const roles = (await hasPermission(db(), actor, 'users.manage'))
      ? await listAssignableRoles(db(), actor)
      : [];
    return json({ users, roles });
  });
}

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    const user = await createUser(db(), actor, await readJson(req, createUserInput), clientIp(req));
    return json({ user }, 201);
  });
}
