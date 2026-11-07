import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Brand } from '@/components/Brand';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { SignupForm } from '@/components/SignupForm';
import { getT } from '@/i18n/server';
import { config } from '@/server/config';
import { db } from '@/server/db';
import { isPlatformRoot } from '@/server/request';
import { DEFAULT_BRANDING, findTenantBySlug } from '@/server/tenants/repo';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('shell.titles.signup') };
}

export default async function SignupPage() {
  if (!(await isPlatformRoot())) redirect('/');
  const cfg = config();
  const singleTenant = Boolean(cfg.defaultTenant);
  if (singleTenant && (await findTenantBySlug(db(), cfg.defaultTenant!))) redirect('/login');
  const t = await getT();

  return (
    <>
      <header className="topbar">
        <Brand branding={DEFAULT_BRANDING} />
        <LanguageSwitcher compact />
      </header>
      <main className="container">
        <div className="card" style={{ maxWidth: 520, margin: '0 auto' }}>
          <h2 style={{ marginTop: 0 }}>{t('shell.signup.title')}</h2>
          <p className="muted">{t('shell.signup.hint')}</p>
          <SignupForm platformDomain={cfg.platformDomain} fixedSlug={cfg.defaultTenant ?? null} />
        </div>
      </main>
    </>
  );
}
