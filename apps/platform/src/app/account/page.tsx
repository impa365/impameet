import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { AccountSecurity } from '@/components/account/AccountSecurity';
import { getT } from '@/i18n/server';
import { currentTenant, currentUser } from '@/server/request';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('security.account.title') };
}

export default async function AccountPage() {
  const ctx = await currentTenant();
  if (!ctx) redirect('/');
  const user = await currentUser();
  if (!user) redirect('/login');
  const t = await getT();
  return (
    <AppShell branding={ctx.branding} user={user} active="account" title={t('security.account.title')}>
      <AccountSecurity setupRequired={Boolean(user.mfaSetupRequired)} />
    </AppShell>
  );
}
