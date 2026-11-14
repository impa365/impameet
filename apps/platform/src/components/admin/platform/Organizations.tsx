'use client';

import Link from 'next/link';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { useLocale, useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/keys';
import { api } from '../../api';
import { Icon } from '../../ui/Icon';
import { platformHref } from '../tabs';
import { messageOf, useLoad } from '../useLoad';
import { type Limits, PLANS, type Plan, TENANTS_API, type Tenant, type TenantsView } from './types';

const PLAN_LABEL: Record<Plan, MessageKey> = {
  free: 'platform.planFree',
  pro: 'platform.planPro',
  enterprise: 'platform.planEnterprise',
};

const planOf = (plan: string): Plan => (PLANS.includes(plan as Plan) ? (plan as Plan) : 'free');

export function PlanBadge(props: { plan: string; custom?: boolean }) {
  const t = useT();
  return (
    <span className="org-badges">
      <span className={`badge plan-${planOf(props.plan)}`}>{t(PLAN_LABEL[planOf(props.plan)])}</span>
      {props.custom && <span className="badge">{t('platform.customLimits')}</span>}
    </span>
  );
}

export function StatusBadge(props: { status: Tenant['status']; self?: boolean }) {
  const t = useT();
  return (
    <span className="org-badges">
      <span className={props.status === 'active' ? 'badge primary' : 'badge warn'}>
        {props.status === 'active' ? t('platform.statusActive') : t('platform.statusSuspended')}
      </span>
      {props.self && <span className="badge">{t('admin.superadmin.yourOrganization')}</span>}
    </span>
  );
}

type StatusFilter = 'all' | Tenant['status'];

/** Every organization, searchable; each opens on a page of its own. */
export function OrganizationsList({ selfTenantId }: { selfTenantId: string }) {
  const t = useT();
  const locale = useLocale();
  const { data, error } = useLoad<TenantsView>(TENANTS_API);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [plan, setPlan] = useState<'all' | Plan>('all');

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.tenants ?? []).filter(
      (x) =>
        (!q || x.name.toLowerCase().includes(q) || x.slug.includes(q)) &&
        (status === 'all' || x.status === status) &&
        (plan === 'all' || planOf(x.plan) === plan),
    );
  }, [data, query, status, plan]);

  return (
    <div className="platform-page">
      <div className="page-head">
        <p>{t('platform.organizationsIntro')}</p>
      </div>
      <div className="filter-bar" role="search">
        <label className="filter-search">
          <Icon name="search" size={18} />
          <input
            type="search"
            value={query}
            placeholder={t('platform.searchPlaceholder')}
            aria-label={t('platform.search')}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as StatusFilter)}
          aria-label={t('platform.filterStatus')}
        >
          <option value="all">{t('platform.allStatuses')}</option>
          <option value="active">{t('platform.statusActive')}</option>
          <option value="suspended">{t('platform.statusSuspended')}</option>
        </select>
        <select
          value={plan}
          onChange={(e) => setPlan(e.target.value as 'all' | Plan)}
          aria-label={t('platform.filterPlan')}
        >
          <option value="all">{t('platform.allPlans')}</option>
          {PLANS.map((p) => (
            <option key={p} value={p}>
              {t(PLAN_LABEL[p])}
            </option>
          ))}
        </select>
        <span className="muted filter-count" role="status">
          {t('platform.count', { count: shown.length })}
        </span>
      </div>
      <div className="error" role="alert">
        {error}
      </div>
      <div className="table-card">
        <table className="grid">
          <thead>
            <tr>
              <th>{t('admin.superadmin.organization')}</th>
              <th>{t('admin.superadmin.plan')}</th>
              <th>{t('platform.usage')}</th>
              <th>{t('platform.created')}</th>
              <th>{t('admin.status')}</th>
              <th>
                <span className="sr-only">{t('platform.manage')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((x) => (
              <tr key={x.id}>
                <td>
                  <strong>{x.name}</strong>
                  <div className="muted">{x.slug}</div>
                </td>
                <td>
                  <PlanBadge plan={x.plan} custom={x.customLimits} />
                </td>
                <td className="muted">
                  {t('admin.superadmin.usageSummary', { users: x.users, rooms: x.rooms, domains: x.domains })}
                </td>
                <td className="muted">{new Date(x.createdAt).toLocaleDateString(locale)}</td>
                <td>
                  <StatusBadge status={x.status} self={x.id === selfTenantId} />
                </td>
                <td className="row-action">
                  <Link className="btn secondary small" href={platformHref('organizations', x.id)}>
                    {t('platform.manage')}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && shown.length === 0 && <p className="muted table-empty">{t('platform.noMatch')}</p>}
      </div>
    </div>
  );
}

interface Draft {
  plan: Plan;
  maxRooms: string;
  maxParticipants: string;
  agents: boolean;
  customDomains: boolean;
  recording: boolean;
}

const draftOf = (x: Tenant): Draft => ({
  plan: planOf(x.plan),
  maxRooms: x.limits.maxRooms === null ? '' : String(x.limits.maxRooms),
  maxParticipants: x.limits.maxParticipants === null ? '' : String(x.limits.maxParticipants),
  agents: x.limits.agents,
  customDomains: x.limits.customDomains,
  recording: x.limits.recording,
});

const fromPlan = (plan: Plan, base: Limits): Draft => ({
  plan,
  maxRooms: base.maxRooms === null ? '' : String(base.maxRooms),
  maxParticipants: base.maxParticipants === null ? '' : String(base.maxParticipants),
  agents: base.agents,
  customDomains: base.customDomains,
  recording: base.recording,
});

/** Empty means unlimited; anything else must be a whole number in range. */
function limitOf(value: string, min: number): number | null | 'bad' {
  const v = value.trim();
  if (!v) return null;
  if (!/^\d+$/.test(v)) return 'bad';
  const n = Number(v);
  return n >= min ? n : 'bad';
}

/** One organization: its numbers, its plan and limits (saved with a button), and suspension. */
export function OrganizationDetail({ id, selfTenantId }: { id: string; selfTenantId: string }) {
  const t = useT();
  const locale = useLocale();
  const { data, error, setError, reload } = useLoad<TenantsView>(TENANTS_API);
  const tenant = data?.tenants.find((x) => x.id === id) ?? null;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<'save' | 'status' | null>(null);
  const [notice, setNotice] = useState('');
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => draft && setDraft({ ...draft, [k]: v });

  useEffect(() => {
    if (tenant) setDraft(draftOf(tenant));
  }, [tenant]);

  if (!data) return <p className="muted">{error || t('common.loading')}</p>;
  if (!tenant || !draft) {
    return (
      <div className="platform-page">
        <Link className="back-link" href={platformHref('organizations')}>
          <Icon name="arrow_back" size={18} /> {t('platform.backToList')}
        </Link>
        <p className="int-empty">{t('platform.notFound')}</p>
      </div>
    );
  }

  const base = data.plans[draft.plan];
  const rooms = limitOf(draft.maxRooms, 0);
  const participants = limitOf(draft.maxParticipants, 2);
  const valid = rooms !== 'bad' && participants !== 'bad';
  const changed = JSON.stringify(draft) !== JSON.stringify(draftOf(tenant));
  const self = tenant.id === selfTenantId;
  const planValue = (v: number | null) => (v === null ? t('admin.superadmin.unlimited') : String(v));
  const planBool = (v: boolean) => (v ? t('platform.included') : t('platform.notIncluded'));

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!draft || rooms === 'bad' || participants === 'bad') return;
    // Only what differs from the plan is stored, so the rest keeps following the plan's defaults.
    const wanted: Limits = {
      maxRooms: rooms,
      maxParticipants: participants,
      agents: draft.agents,
      customDomains: draft.customDomains,
      recording: draft.recording,
    };
    const limits = Object.fromEntries(
      (Object.keys(wanted) as (keyof Limits)[])
        .filter((k) => wanted[k] !== base[k])
        .map((k) => [k, wanted[k]]),
    );
    setBusy('save');
    setNotice('');
    try {
      await api(`${TENANTS_API}/${tenant!.id}`, { method: 'PATCH', body: { plan: draft.plan, limits } });
      await reload();
      setNotice(t('platform.saved'));
    } catch (err) {
      setError(messageOf(err, t('admin.couldNotSave')));
    } finally {
      setBusy(null);
    }
  }

  async function toggleStatus() {
    const suspend = tenant!.status === 'active';
    if (
      !window.confirm(
        t(suspend ? 'platform.suspendConfirm' : 'platform.reactivateConfirm', { name: tenant!.name }),
      )
    )
      return;
    setBusy('status');
    setNotice('');
    try {
      await api(`${TENANTS_API}/${tenant!.id}`, {
        method: 'PATCH',
        body: { status: suspend ? 'suspended' : 'active' },
      });
      await reload();
      setNotice(suspend ? t('platform.suspended') : t('platform.reactivated'));
    } catch (err) {
      setError(messageOf(err, t('admin.couldNotSave')));
    } finally {
      setBusy(null);
    }
  }

  const diff = (k: keyof Limits) => {
    const v = k === 'maxRooms' ? rooms : k === 'maxParticipants' ? participants : (draft[k] as boolean);
    return v !== 'bad' && v !== base[k];
  };

  return (
    <div className="platform-page">
      <Link className="back-link" href={platformHref('organizations')}>
        <Icon name="arrow_back" size={18} /> {t('platform.backToList')}
      </Link>

      <header className="org-head">
        <span className="stat-icon big" aria-hidden>
          <Icon name="apartment" size={28} />
        </span>
        <div>
          <h2>{tenant.name}</h2>
          <p className="muted">
            {tenant.slug} ·{' '}
            {t('platform.createdOn', { date: new Date(tenant.createdAt).toLocaleDateString(locale) })}
          </p>
        </div>
        <StatusBadge status={tenant.status} self={self} />
      </header>

      <div className="stat-grid three">
        <div className="stat-card">
          <span className="stat-body">
            <small>{t('platform.statUsers')}</small>
            <strong>{tenant.users}</strong>
          </span>
        </div>
        <div className="stat-card">
          <span className="stat-body">
            <small>{t('platform.statRooms')}</small>
            <strong>{tenant.rooms}</strong>
          </span>
        </div>
        <div className="stat-card">
          <span className="stat-body">
            <small>{t('platform.statDomains')}</small>
            <strong>{tenant.domains}</strong>
          </span>
        </div>
      </div>

      <form className="form settings-section" onSubmit={save} noValidate>
        <header className="section-head">
          <h3>{t('platform.planTitle')}</h3>
          <p>{t('platform.planIntro')}</p>
        </header>
        <div className="kind-chooser" role="radiogroup" aria-label={t('admin.superadmin.plan')}>
          {PLANS.map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={draft.plan === p}
              className={draft.plan === p ? 'kind-option selected' : 'kind-option'}
              onClick={() => setDraft(fromPlan(p, data.plans[p]))}
            >
              <span>
                <strong>{t(PLAN_LABEL[p])}</strong>
                <small>
                  {t('platform.planSummary', {
                    rooms: planValue(data.plans[p].maxRooms),
                    participants: planValue(data.plans[p].maxParticipants),
                  })}
                </small>
              </span>
            </button>
          ))}
        </div>

        <h4>{t('platform.limitsTitle')}</h4>
        <div className="fields">
          <label>
            {t('admin.superadmin.roomsLimit')}
            <input
              inputMode="numeric"
              value={draft.maxRooms}
              placeholder={t('admin.superadmin.unlimited')}
              aria-invalid={rooms === 'bad'}
              onChange={(e) => set('maxRooms', e.target.value)}
            />
            <span className={diff('maxRooms') ? 'field-help changed' : 'field-help'}>
              {t('platform.planDefault', { value: planValue(base.maxRooms) })}
            </span>
          </label>
          <label>
            {t('admin.superadmin.participantsPerRoom')}
            <input
              inputMode="numeric"
              value={draft.maxParticipants}
              placeholder={t('admin.superadmin.unlimited')}
              aria-invalid={participants === 'bad'}
              onChange={(e) => set('maxParticipants', e.target.value)}
            />
            <span className={diff('maxParticipants') ? 'field-help changed' : 'field-help'}>
              {t('platform.planDefault', { value: planValue(base.maxParticipants) })}
            </span>
          </label>
        </div>
        {!valid && <p className="error">{t('platform.limitsInvalid')}</p>}
        {(
          [
            ['agents', 'platform.featureAgents', 'platform.featureAgentsHelp'],
            ['customDomains', 'platform.featureDomains', 'platform.featureDomainsHelp'],
            ['recording', 'platform.featureRecording', 'platform.featureRecordingHelp'],
          ] as const
        ).map(([k, label, help]) => (
          <label key={k} className="switch">
            <input type="checkbox" checked={draft[k]} onChange={(e) => set(k, e.target.checked)} />
            <span>
              {t(label)}
              <small className={diff(k) ? 'changed' : undefined}>
                {t(help)} {t('platform.planDefault', { value: planBool(base[k]) })}
              </small>
            </span>
          </label>
        ))}
        <div className="save-bar">
          <button className="btn" disabled={busy !== null || !changed || !valid}>
            {busy === 'save' ? t('platform.saving') : t('platform.save')}
          </button>
          <button
            type="button"
            className="btn secondary"
            disabled={busy !== null}
            onClick={() => setDraft(fromPlan(draft.plan, base))}
          >
            {t('platform.usePlanLimits')}
          </button>
          {changed && <span className="muted">{t('platform.unsaved')}</span>}
        </div>
      </form>

      <section className="settings-section danger-zone">
        <header className="section-head">
          <h3>{tenant.status === 'active' ? t('platform.suspendTitle') : t('platform.reactivateTitle')}</h3>
          <p>
            {self
              ? t('platform.cannotSuspendSelf')
              : tenant.status === 'active'
                ? t('platform.suspendHelp')
                : t('platform.reactivateHelp')}
          </p>
        </header>
        {!self && (
          <div className="save-bar">
            <button
              type="button"
              className={tenant.status === 'active' ? 'btn danger' : 'btn'}
              disabled={busy !== null}
              onClick={() => void toggleStatus()}
            >
              {tenant.status === 'active' ? t('admin.superadmin.suspend') : t('admin.reactivate')}
            </button>
          </div>
        )}
      </section>

      {notice && (
        <p className="status-line" role="status">
          {notice}
        </p>
      )}
      <div className="error" role="alert">
        {error}
      </div>
    </div>
  );
}
