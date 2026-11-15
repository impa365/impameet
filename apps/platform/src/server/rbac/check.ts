import type { SessionUser } from '../auth/session';
import type { OrgPermission } from './permissions';

/** Sync check against permissions loaded on the session (preferred). */
export function sessionHas(user: Pick<SessionUser, 'permissions' | 'role'> | null, permission: OrgPermission): boolean {
  if (!user) return false;
  if (user.permissions?.includes(permission)) return true;
  // Legacy fallback before sessions carry permissions (should be rare).
  if (!user.permissions?.length) {
    if (permission === 'rooms.manage_all' || permission === 'panel.access' || permission === 'users.view') {
      return user.role === 'admin' || user.role === 'manager';
    }
    return user.role === 'admin';
  }
  return false;
}
