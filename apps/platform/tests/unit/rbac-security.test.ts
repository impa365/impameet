import { describe, expect, it } from 'vitest';
import { ORG_PERMISSIONS, PLATFORM_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '@/server/rbac/permissions';
import { sessionHas } from '@/server/rbac/check';

describe('rbac security boundaries', () => {
  it('keeps platform permissions out of the org catalog', () => {
    for (const code of PLATFORM_PERMISSIONS) {
      expect(code.startsWith('platform.')).toBe(true);
      expect((ORG_PERMISSIONS as readonly string[]).includes(code)).toBe(false);
    }
    for (const code of ORG_PERMISSIONS) {
      expect(code.startsWith('platform.')).toBe(false);
    }
  });

  it('gives managers rooms.manage_all by default but not roles.manage', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.manager).toContain('rooms.manage_all');
    expect(DEFAULT_ROLE_PERMISSIONS.manager).not.toContain('roles.manage');
    expect(DEFAULT_ROLE_PERMISSIONS.admin).toContain('roles.manage');
    expect(DEFAULT_ROLE_PERMISSIONS.member).toHaveLength(0);
  });

  it('sessionHas never invents platform powers from org permissions', () => {
    const user = {
      role: 'admin',
      permissions: [...ORG_PERMISSIONS],
    };
    expect(sessionHas(user, 'roles.manage')).toBe(true);
    expect(user.permissions.some((p) => p.startsWith('platform.'))).toBe(false);
  });
});
