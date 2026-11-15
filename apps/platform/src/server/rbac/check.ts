import type { SessionUser } from '../auth/session';
import {
  DEFAULT_ROLE_PERMISSIONS,
  type OrgPermission,
  SYSTEM_ROLE_KEYS,
  type SystemRoleKey,
} from './permissions';

/** Sync check against permissions loaded on the session (preferred). */
export function sessionHas(
  user: Pick<SessionUser, 'permissions' | 'role'> | null,
  permission: OrgPermission,
): boolean {
  if (!user) return false;
  if (user.permissions?.includes(permission)) return true;
  // Explicit empty list means “no powers” (do not fall back to role defaults).
  if (user.permissions && user.permissions.length === 0) return false;
  // Tests and older SessionUser shapes: use the built-in matrix for system roles.
  if ((SYSTEM_ROLE_KEYS as readonly string[]).includes(user.role)) {
    return DEFAULT_ROLE_PERMISSIONS[user.role as SystemRoleKey].includes(permission);
  }
  return false;
}
