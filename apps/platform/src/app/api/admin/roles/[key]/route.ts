import { db } from '@/server/db';
import { writerUser } from '@/server/guard';
import { clientIp, handle, json, readJson } from '@/server/http';
import type { OrgPermission } from '@/server/rbac/permissions';
import { deleteOrgRole, updateOrgRolePermissions } from '@/server/rbac/service';
import { orgRolePermissionsInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    const { key } = await params;
    const input = await readJson(req, orgRolePermissionsInput);
    const role = await updateOrgRolePermissions(
      db(),
      actor,
      key,
      input.permissions as OrgPermission[],
      clientIp(req),
    );
    return json({ role });
  });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    const { key } = await params;
    await deleteOrgRole(db(), actor, key, clientIp(req));
    return json({ ok: true });
  });
}
