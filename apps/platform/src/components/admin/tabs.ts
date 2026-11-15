import type { MessageKey } from '@/i18n/keys';
import type { IconName } from '../ui/Icon';

export type AdminTab =
  | 'agents'
  | 'knowledge'
  | 'integrations'
  | 'users'
  | 'roles'
  | 'live'
  | 'branding'
  | 'domains'
  | 'email'
  | 'storage'
  | 'streaming'
  | 'security'
  | 'audit';

export const ADMIN_TABS: Record<AdminTab, { label: MessageKey; icon: IconName }> = {
  agents: { label: 'shell.nav.tabs.agents', icon: 'smart_toy' },
  knowledge: { label: 'shell.nav.tabs.knowledge', icon: 'menu_book' },
  integrations: { label: 'shell.nav.tabs.integrations', icon: 'hub' },
  users: { label: 'shell.nav.tabs.users', icon: 'group' },
  roles: { label: 'shell.nav.tabs.roles', icon: 'shield_person' },
  live: { label: 'shell.nav.tabs.live', icon: 'sensors' },
  branding: { label: 'shell.nav.tabs.branding', icon: 'palette' },
  domains: { label: 'shell.nav.tabs.domains', icon: 'language' },
  email: { label: 'shell.nav.tabs.email', icon: 'mail' },
  storage: { label: 'shell.nav.tabs.storage', icon: 'cloud_upload' },
  streaming: { label: 'shell.nav.tabs.streaming', icon: 'live_tv' },
  security: { label: 'shell.nav.tabs.security', icon: 'verified_user' },
  audit: { label: 'shell.nav.tabs.audit', icon: 'history' },
};

const TAB_PERM: Record<AdminTab, string> = {
  agents: 'agents.manage',
  knowledge: 'knowledge.manage',
  integrations: 'integrations.manage',
  users: 'users.view',
  roles: 'roles.manage',
  live: 'live.manage',
  branding: 'branding.manage',
  domains: 'domains.manage',
  email: 'email.manage',
  storage: 'storage.manage',
  streaming: 'streaming.manage',
  security: 'security.manage',
  audit: 'audit.view',
};

/** Tabs unlocked by the session's org permissions (platform.* never appear here). */
export function adminTabsForPermissions(permissions: readonly string[]): AdminTab[] {
  if (!permissions.includes('panel.access')) return [];
  return (Object.keys(TAB_PERM) as AdminTab[]).filter((tab) => permissions.includes(TAB_PERM[tab]));
}

/** @deprecated Prefer adminTabsForPermissions. */
export function adminTabsFor(role: string): AdminTab[] {
  if (role === 'admin')
    return [
      'agents',
      'knowledge',
      'integrations',
      'users',
      'roles',
      'live',
      'branding',
      'domains',
      'email',
      'storage',
      'streaming',
      'security',
      'audit',
    ];
  if (role === 'manager') return ['users', 'live'];
  return [];
}

export function pickAdminTab(
  roleOrPerms: string | readonly string[],
  requested: string | undefined,
): AdminTab {
  const tabs = Array.isArray(roleOrPerms)
    ? adminTabsForPermissions(roleOrPerms)
    : adminTabsFor(roleOrPerms as string);
  return tabs.find((t) => t === requested) ?? tabs[0] ?? 'users';
}

/** The platform's own pages (super admins): above every organization. */
export type PlatformTab = 'overview' | 'organizations' | 'superadmins' | 'email' | 'google';

export const PLATFORM_TABS: Record<PlatformTab, { label: MessageKey; icon: IconName }> = {
  overview: { label: 'shell.nav.platformTabs.overview', icon: 'dashboard' },
  organizations: { label: 'shell.nav.platformTabs.organizations', icon: 'apartment' },
  superadmins: { label: 'shell.nav.platformTabs.superadmins', icon: 'shield_person' },
  email: { label: 'shell.nav.platformTabs.email', icon: 'mail' },
  google: { label: 'shell.nav.platformTabs.google', icon: 'hub' },
};

export function pickPlatformTab(requested: string | undefined): PlatformTab {
  return (Object.keys(PLATFORM_TABS) as PlatformTab[]).find((t) => t === requested) ?? 'overview';
}

export const platformHref = (tab: PlatformTab, org?: string) =>
  tab === 'overview'
    ? '/superadmin'
    : `/superadmin?tab=${tab}${org ? `&org=${encodeURIComponent(org)}` : ''}`;

export type DashboardView = 'rooms' | 'meetings' | 'recordings' | 'transcripts' | 'reports';

export const DASHBOARD_VIEWS: Record<DashboardView, { label: MessageKey; icon: IconName }> = {
  rooms: { label: 'shell.nav.views.rooms', icon: 'video_call' },
  meetings: { label: 'shell.nav.views.meetings', icon: 'calendar_month' },
  recordings: { label: 'shell.nav.views.recordings', icon: 'video_library' },
  transcripts: { label: 'shell.nav.views.transcripts', icon: 'description' },
  reports: { label: 'shell.nav.views.reports', icon: 'summarize' },
};

export function pickDashboardView(requested: string | undefined): DashboardView {
  return (Object.keys(DASHBOARD_VIEWS) as DashboardView[]).find((v) => v === requested) ?? 'rooms';
}
