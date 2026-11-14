'use client';

import Link from 'next/link';
import { useLocale, useT } from '@/i18n/client';
import { Icon, type IconName } from '../../ui/Icon';
import { platformHref } from '../tabs';
import { useLoad } from '../useLoad';
import { PlanBadge, StatusBadge } from './Organizations';
import { TENANTS_API, type TenantsView } from './types';

function Stat(props: { icon: IconName; label: string; value: number; detail?: string }) {
  return (
    <div className="stat-card">
      <span className="stat-icon" aria-hidden>
        <Icon name={props.icon} size={20} />
      </span>
      <span className="stat-body">
        <small>{props.label}</small>
        <strong>{props.value.toLocaleString()}</strong>
        {props.detail && <small className="muted">{props.detail}</small>}
      </span>
    </div>
  );
}

function SetupRow(props: {
  icon: IconName;
  title: string;
  ok: boolean | null;
  okText: string;
  missingText: string;
  href: string;
}) {
  const t = useT();
  return (
    <li className="setup-row">
      <span className="stat-icon" aria-hidden>
        <Icon name={props.icon} size={20} />
      </span>
      <span className="setup-main">
        <strong>{props.title}</strong>
        <small className="muted">
          <span
            className={props.ok === null ? 'status-dot idle' : props.ok ? 'status-dot' : 'status-dot warn'}
            aria-hidden
          />{' '}
          {props.ok === null ? t('common.loading') : props.ok ? props.okText : props.missingText}
        </small>
      </span>
      <Link className="btn secondary small" href={props.href}>
        {props.ok ? t('platform.manage') : t('platform.configure')}
      </Link>
    </li>
  );
}

/** The platform at a glance: how many organizations and people, and what is still to set up. */
export function PlatformOverview({ selfTenantId }: { selfTenantId: string }) {
  const t = useT();
  const locale = useLocale();
  const { data, error } = useLoad<TenantsView>(TENANTS_API);
  const mail = useLoad<{ mail: { server: unknown; legacy: boolean } }>('/api/superadmin/mail');
  const google = useLoad<{ google: { clientId: string | null; hasSecret: boolean } }>(
    '/api/superadmin/google',
  );
  const tenants = data?.tenants ?? [];
  const active = tenants.filter((x) => x.status === 'active').length;
  const sum = (k: 'users' | 'rooms' | 'domains') => tenants.reduce((n, x) => n + x[k], 0);

  return (
    <div className="platform-page">
      <div className="page-head">
        <p>{t('platform.overviewIntro')}</p>
      </div>
      <div className="error" role="alert">
        {error}
      </div>
      <div className="stat-grid">
        <Stat
          icon="apartment"
          label={t('platform.statOrganizations')}
          value={tenants.length}
          detail={t('platform.statOrganizationsDetail', { active, suspended: tenants.length - active })}
        />
        <Stat icon="group" label={t('platform.statUsers')} value={sum('users')} />
        <Stat icon="video_call" label={t('platform.statRooms')} value={sum('rooms')} />
        <Stat icon="language" label={t('platform.statDomains')} value={sum('domains')} />
      </div>

      <section className="settings-section">
        <header className="section-head">
          <h3>{t('platform.setupTitle')}</h3>
          <p>{t('platform.setupIntro')}</p>
        </header>
        <ul className="setup-list">
          <SetupRow
            icon="mail"
            title={t('shell.nav.platformTabs.email')}
            ok={mail.data ? Boolean(mail.data.mail.server || mail.data.mail.legacy) : null}
            okText={t('platform.mailOk')}
            missingText={t('platform.mailMissing')}
            href={platformHref('email')}
          />
          <SetupRow
            icon="hub"
            title={t('shell.nav.platformTabs.google')}
            ok={google.data ? Boolean(google.data.google.clientId && google.data.google.hasSecret) : null}
            okText={t('platform.googleOk')}
            missingText={t('platform.googleMissing')}
            href={platformHref('google')}
          />
        </ul>
      </section>

      <section className="settings-section">
        <header className="section-head with-action">
          <h3>{t('platform.recentTitle')}</h3>
          <Link className="btn text small" href={platformHref('organizations')}>
            {t('platform.seeAll')} <Icon name="arrow_forward" size={16} />
          </Link>
        </header>
        {tenants.length === 0 ? (
          <p className="muted">{data ? t('platform.none') : t('common.loading')}</p>
        ) : (
          <ul className="org-list">
            {tenants.slice(0, 5).map((x) => (
              <li key={x.id}>
                <Link className="org-row" href={platformHref('organizations', x.id)}>
                  <span className="org-main">
                    <strong>{x.name}</strong>
                    <small className="muted">
                      {x.slug} ·{' '}
                      {t('platform.createdOn', { date: new Date(x.createdAt).toLocaleDateString(locale) })}
                    </small>
                  </span>
                  <PlanBadge plan={x.plan} custom={x.customLimits} />
                  <StatusBadge status={x.status} self={x.id === selfTenantId} />
                  <Icon name="chevron_right" size={20} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
