import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { AdminPanel } from '@/components/admin/AdminPanel';
import { ADMIN_TABS, pickAdminTab } from '@/components/admin/tabs';
import { getT } from '@/i18n/server';
import { currentTenant, currentUser } from '@/server/request';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('shell.titles.admin') };
}

export default async function AdminPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const ctx = await currentTenant();
  if (!ctx) redirect('/');
  const user = await currentUser();
  if (!user) redirect('/login');
  if (user.role === 'member') redirect('/dashboard');
  const t = await getT();
  const tab = pickAdminTab(user.role, (await searchParams).tab);

  return (
    <AppShell branding={ctx.branding} user={user} active={`admin:${tab}`} title={t(ADMIN_TABS[tab].label)}>
      <AdminPanel tab={tab} role={user.role} selfId={user.id} branding={ctx.branding} />
    </AppShell>
  );
}
