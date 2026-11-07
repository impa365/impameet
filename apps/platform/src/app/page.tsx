import Link from 'next/link';
import { Brand } from '@/components/Brand';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { StartMeeting } from '@/components/StartMeeting';
import { ThemeToggle } from '@/components/ThemeToggle';
import { getT } from '@/i18n/server';
import { currentTenant, currentUser, isPlatformRoot } from '@/server/request';
import { DEFAULT_BRANDING } from '@/server/tenants/repo';

export default async function Home() {
  const ctx = await currentTenant();
  const t = await getT();

  if (!ctx) {
    const root = await isPlatformRoot();
    return (
      <>
        <header className="topbar">
          <Brand branding={DEFAULT_BRANDING} />
          <div className="row">
            <LanguageSwitcher compact />
            <ThemeToggle />
          </div>
        </header>
        <main className="landing">
          <h1>{root ? t('shell.home.platformTitle') : t('shell.home.notFoundTitle')}</h1>
          <p>{root ? t('shell.home.platformText') : t('shell.home.notFoundText')}</p>
          {root && (
            <Link className="btn large" href="/signup">
              {t('shell.home.createOrg')}
            </Link>
          )}
        </main>
      </>
    );
  }

  const user = await currentUser();
  return (
    <>
      <header className="topbar">
        <Brand branding={ctx.branding} />
        <div className="row">
          <LanguageSwitcher compact />
          <ThemeToggle />
          <Link className="btn tonal small" href={user ? '/dashboard' : '/login'}>
            {user ? t('shell.home.myRooms') : t('shell.home.signIn')}
          </Link>
        </div>
      </header>
      <main className="landing">
        <h1>{t('shell.home.title')}</h1>
        <p>{t('shell.home.text', { product: ctx.branding.productName })}</p>
        <StartMeeting signedIn={Boolean(user)} />
      </main>
    </>
  );
}
