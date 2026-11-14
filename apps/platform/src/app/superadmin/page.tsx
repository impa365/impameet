import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { SuperadminPanel } from '@/components/admin/SuperadminPanel';
import { PLATFORM_TABS, pickPlatformTab } from '@/components/admin/tabs';
import { getT } from '@/i18n/server';
import { currentTenant, currentUser } from '@/server/request';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('shell.titles.superadminShort') };
}

export default async function SuperadminPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; org?: string }>;
}) {
  const ctx = await currentTenant();
  if (!ctx) redirect('/');
  const user = await currentUser();
  if (!user) redirect('/login');
  if (!user.isSuperadmin) redirect('/dashboard');
  const t = await getT();
  const params = await searchParams;
  const tab = pickPlatformTab(params.tab);
  const org = tab === 'organizations' && params.org && params.org.length <= 64 ? params.org : null;

  return (
    <AppShell
      branding={ctx.branding}
      user={user}
      active={`superadmin:${tab}`}
      title={t(PLATFORM_TABS[tab].label)}
    >
      <SuperadminPanel tab={tab} org={org} selfTenantId={user.tenantId} />
    </AppShell>
  );
}
