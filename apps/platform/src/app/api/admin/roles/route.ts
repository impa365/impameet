import { db } from '@/server/db';
import { readerUser, writerUser } from '@/server/guard';
import { clientIp, handle, json, readJson } from '@/server/http';
import {
  createOrgRole,
  listOrgPermissionDefs,
  listOrgRoles,
} from '@/server/rbac/service';
import type { OrgPermission } from '@/server/rbac/permissions';
import { orgRoleCreateInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return handle(async () => {
    const actor = await readerUser();
    const [roles, permissions] = await Promise.all([
      listOrgRoles(db(), actor),
      listOrgPermissionDefs(db()),
    ]);
    return json({ roles, permissions });
  });
}

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    const input = await readJson(req, orgRoleCreateInput);
    const role = await createOrgRole(
      db(),
      actor,
      {
        key: input.key,
        name: input.name,
        description: input.description,
        permissions: input.permissions as OrgPermission[],
      },
      clientIp(req),
    );
    return json({ role }, 201);
  });
}
