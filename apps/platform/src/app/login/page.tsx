import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Brand } from '@/components/Brand';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { LoginForm } from '@/components/LoginForm';
import { getT } from '@/i18n/server';
import { currentTenant, currentUser } from '@/server/request';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('shell.titles.login') };
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ email?: string }> }) {
  const ctx = await currentTenant();
  if (!ctx) redirect('/');
  if (await currentUser()) redirect('/dashboard');
  const t = await getT();
  const { email } = await searchParams;
  return (
    <>
      <header className="topbar">
        <Brand branding={ctx.branding} />
        <LanguageSwitcher compact />
      </header>
      <main className="container">
        <div className="card" style={{ maxWidth: 460, margin: '0 auto' }}>
          <h2 style={{ marginTop: 0 }}>{t('shell.login.title', { org: ctx.tenant.name })}</h2>
          <LoginForm initialEmail={email ?? ''} />
        </div>
      </main>
    </>
  );
}
