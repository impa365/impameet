/** Tenant-scoped permission codes. Never include platform.* here. */
export const ORG_PERMISSIONS = [
  'panel.access',
  'users.view',
  'users.manage',
  'users.assign_admin',
  'roles.manage',
  'rooms.manage_all',
  'agents.manage',
  'knowledge.manage',
  'integrations.manage',
  'branding.manage',
  'domains.manage',
  'email.manage',
  'storage.manage',
  'live.manage',
  'streaming.manage',
  'security.manage',
  'audit.view',
] as const;

export type OrgPermission = (typeof ORG_PERMISSIONS)[number];

/** Platform-only powers. Stored only on platform_permission_defs — never on org roles. */
export const PLATFORM_PERMISSIONS = [
  'platform.tenants.manage',
  'platform.mail.manage',
  'platform.google.manage',
  'platform.superadmins.manage',
] as const;

export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

export const SYSTEM_ROLE_KEYS = ['admin', 'manager', 'member'] as const;
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

/** Default permission sets for built-in roles (also seeded in migration 0033). */
export const DEFAULT_ROLE_PERMISSIONS: Record<SystemRoleKey, readonly OrgPermission[]> = {
  admin: ORG_PERMISSIONS,
  manager: ['panel.access', 'users.view', 'users.manage', 'rooms.manage_all', 'live.manage'],
  member: [],
};

/** Which admin tabs a permission unlocks. */
export const TAB_PERMISSION: Record<string, OrgPermission> = {
  agents: 'agents.manage',
  knowledge: 'knowledge.manage',
  integrations: 'integrations.manage',
  users: 'users.view',
  live: 'live.manage',
  branding: 'branding.manage',
  domains: 'domains.manage',
  email: 'email.manage',
  storage: 'storage.manage',
  streaming: 'streaming.manage',
  security: 'security.manage',
  audit: 'audit.view',
  roles: 'roles.manage',
};
