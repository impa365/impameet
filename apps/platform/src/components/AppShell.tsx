import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { getT } from '@/i18n/server';
import type { SessionUser } from '@/server/auth/session';
import type { Branding } from '@/server/tenants/repo';
import { Brand } from './Brand';
import { LanguageSwitcher } from './LanguageSwitcher';
import { LogoutButton } from './LogoutButton';
import { NavDrawerToggle } from './NavDrawerToggle';
import { ThemeToggle } from './ThemeToggle';
import {
  ADMIN_TABS,
  DASHBOARD_VIEWS,
  type DashboardView,
  PLATFORM_TABS,
  type PlatformTab,
  adminTabsFor,
  platformHref,
} from './admin/tabs';
import { Avatar } from './meet/Avatar';
import { Icon, type IconName } from './ui/Icon';

function NavLink(props: { href: string; icon: IconName; label: string; active: boolean }) {
  return (
    <Link
      href={props.href}
      className={props.active ? 'nav-link active' : 'nav-link'}
      aria-current={props.active ? 'page' : undefined}
    >
      <Icon name={props.icon} size={20} />
      <span>{props.label}</span>
    </Link>
  );
}

/** The signed-in panel: side navigation, a top bar with language and theme, and the page. */
export async function AppShell(props: {
  branding: Branding;
  user: Pick<SessionUser, 'name' | 'role' | 'isSuperadmin' | 'mfaSetupRequired'>;
  active: string;
  title: string;
  children: ReactNode;
}) {
  const t = await getT();
  const { user, active } = props;
  // The organization requires two-step verification: nothing else until it is set up.
  if (user.mfaSetupRequired && active !== 'account') redirect('/account?setup=1');
  const adminTabs = adminTabsFor(user.role);
  return (
    <div className="shell">
      <a className="skip-link" href="#conteudo">
        {t('common.skipToContent')}
      </a>
      <aside className="shell-nav" id="shell-nav">
        <div className="shell-brand">
          <Brand branding={props.branding} />
        </div>
        <Link href="/" className="nav-cta">
          <Icon name="video_call" size={22} />
          {t('shell.nav.newMeeting')}
        </Link>
        <nav aria-label={t('shell.nav.main')}>
          <p className="nav-section">{t('shell.nav.meetings')}</p>
          {(Object.keys(DASHBOARD_VIEWS) as DashboardView[]).map((v) => (
            <NavLink
              key={v}
              href={v === 'rooms' ? '/dashboard' : `/dashboard?view=${v}`}
              icon={DASHBOARD_VIEWS[v].icon}
              label={t(DASHBOARD_VIEWS[v].label)}
              active={active === `dashboard:${v}`}
            />
          ))}
          {adminTabs.length > 0 && <p className="nav-section">{t('shell.nav.administration')}</p>}
          {adminTabs.map((tab) => (
            <NavLink
              key={tab}
              href={`/admin?tab=${tab}`}
              icon={ADMIN_TABS[tab].icon}
              label={t(ADMIN_TABS[tab].label)}
              active={active === `admin:${tab}`}
            />
          ))}
          {user.isSuperadmin && (
            <>
              <p className="nav-section">{t('shell.nav.platform')}</p>
              {(Object.keys(PLATFORM_TABS) as PlatformTab[]).map((tab) => (
                <NavLink
                  key={tab}
                  href={platformHref(tab)}
                  icon={PLATFORM_TABS[tab].icon}
                  label={t(PLATFORM_TABS[tab].label)}
                  active={active === `superadmin:${tab}`}
                />
              ))}
            </>
          )}
        </nav>
      </aside>
      <div className="shell-main">
        <header className="shell-top">
          <NavDrawerToggle openLabel={t('shell.nav.openMenu')} closeLabel={t('shell.nav.closeMenu')} />
          <h1>{props.title}</h1>
          <div className="shell-tools">
            <LanguageSwitcher compact />
            <ThemeToggle />
            <Link
              href="/account"
              className="shell-user"
              aria-current={active === 'account' ? 'page' : undefined}
              title={t('security.account.title')}
            >
              <Avatar name={user.name} size={32} />
              <span>
                {user.name}
                <small>{t(`common.roles.${user.role}`)}</small>
              </span>
            </Link>
            <LogoutButton />
          </div>
        </header>
        <main className="shell-content" id="conteudo" tabIndex={-1}>
          {props.children}
        </main>
      </div>
    </div>
  );
}
