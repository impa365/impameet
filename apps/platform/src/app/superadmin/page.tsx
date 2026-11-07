import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { SuperadminPanel } from '@/components/admin/SuperadminPanel';
import { getT } from '@/i18n/server';
import { currentTenant, currentUser } from '@/server/request';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('shell.titles.superadminShort') };
}

export default async function SuperadminPage() {
  const ctx = await currentTenant();
  if (!ctx) redirect('/');
  const user = await currentUser();
  if (!user) redirect('/login');
  if (!user.isSuperadmin) redirect('/dashboard');
  const t = await getT();

  return (
    <AppShell branding={ctx.branding} user={user} active="superadmin" title={t('shell.titles.superadmin')}>
      <SuperadminPanel selfTenantId={user.tenantId} />
    </AppShell>
  );
}
