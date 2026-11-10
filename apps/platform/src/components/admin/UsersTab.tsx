'use client';

import { type FormEvent, useState } from 'react';
import { useLocale, useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/keys';
import { Icon } from '../ui/Icon';
import { api } from '../api';
import { messageOf, useLoad } from './useLoad';

type Role = 'admin' | 'manager' | 'member';

interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: 'active' | 'disabled';
  lastLoginAt: string | null;
  mfa: boolean;
}

const ROLE_LABEL = {
  admin: 'common.roles.admin',
  manager: 'common.roles.manager',
  member: 'common.roles.member',
} as const satisfies Record<Role, MessageKey>;

export function UsersTab({ role, selfId }: { role: 'admin' | 'manager'; selfId: string }) {
  const t = useT();
  const locale = useLocale();
  const { data, error, setError, reload } = useLoad<{ users: User[] }>('/api/admin/users');
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'member' as Role });
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const roles: Role[] = role === 'admin' ? ['member', 'manager', 'admin'] : ['member'];
  const canEdit = (u: User) => u.id !== selfId && (role === 'admin' || u.role === 'member');

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/api/admin/users', { body: form });
      setForm({ name: '', email: '', password: '', role: 'member' });
      setCreating(false);
      await reload();
    } catch (err) {
      setError(messageOf(err, t('admin.users.couldNotCreate')));
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: string, body: Record<string, unknown>) {
    try {
      await api(`/api/admin/users/${id}`, { method: 'PATCH', body });
      await reload();
    } catch (err) {
      setError(messageOf(err, t('admin.couldNotSave')));
    }
  }

  async function resetMfa(u: User) {
    if (!window.confirm(t('security.admin.confirmReset', { name: u.name }))) return;
    try {
      await api(`/api/admin/users/${u.id}/mfa`, { method: 'DELETE', body: {} });
      await reload();
      window.alert(t('security.admin.resetDone'));
    } catch (err) {
      setError(messageOf(err, t('admin.couldNotSave')));
    }
  }

  async function resetPassword(u: User) {
    const password = window.prompt(t('admin.users.newPasswordPrompt', { name: u.name }));
    if (password) await patch(u.id, { password });
  }

  return (
    <>
      <div className="page-head">
        <p>{t('admin.users.intro')}</p>
        {!creating && (
          <button className="btn" onClick={() => setCreating(true)}>
            <Icon name="add" size={18} />
            {t('admin.users.newUser')}
          </button>
        )}
      </div>
      {creating && (
        <form onSubmit={create} className="form settings-section panel-form">
          <header className="section-head">
            <h3>{t('admin.users.newUser')}</h3>
          </header>
          <div className="fields">
            <label>
              {t('admin.users.name')}
              <input
                required
                maxLength={80}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <label>
              {t('admin.users.email')}
              <input
                required
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </label>
            <label>
              {t('admin.users.initialPassword')}
              <input
                required
                type="password"
                minLength={10}
                autoComplete="new-password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            </label>
            <label>
              {t('admin.users.role')}
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {t(ROLE_LABEL[r])}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="row">
            <button className="btn" disabled={busy}>
              {t('common.create')}
            </button>
            <button type="button" className="btn secondary" onClick={() => setCreating(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </form>
      )}
      <div className="error" role="alert">
        {error}
      </div>
      <div className="table-card">
        <table className="grid">
          <thead>
            <tr>
              <th>{t('admin.users.name')}</th>
              <th>{t('admin.users.email')}</th>
              <th>{t('admin.users.role')}</th>
              <th>{t('admin.status')}</th>
              <th>{t('admin.users.lastAccess')}</th>
              <th>
                <span className="sr-only">{t('admin.users.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data?.users.map((u) => (
              <tr key={u.id}>
                <td className="strong">
                  {u.name}
                  {u.mfa && (
                    <span className="badge primary" title={t('security.account.mfaTitle')}>
                      {t('security.admin.mfaBadge')}
                    </span>
                  )}
                </td>
                <td className="muted">{u.email}</td>
                <td>
                  {canEdit(u) ? (
                    <select
                      className="inline-select"
                      value={u.role}
                      aria-label={t('admin.users.roleOf', { name: u.name })}
                      onChange={(e) => patch(u.id, { role: e.target.value })}
                    >
                      {(role === 'admin'
                        ? (['member', 'manager', 'admin'] as Role[])
                        : (['member'] as Role[])
                      ).map((r) => (
                        <option key={r} value={r}>
                          {t(ROLE_LABEL[r])}
                        </option>
                      ))}
                    </select>
                  ) : (
                    t(ROLE_LABEL[u.role])
                  )}
                </td>
                <td>
                  <span className="status-line">
                    <span className={u.status === 'active' ? 'status-dot' : 'status-dot idle'} aria-hidden />
                    {u.status === 'active' ? t('admin.users.active') : t('admin.users.disabled')}
                  </span>
                </td>
                <td className="muted">
                  {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString(locale) : '—'}
                </td>
                <td>
                  {canEdit(u) && (
                    <span className="row-actions">
                      <button className="btn text small" onClick={() => resetPassword(u)}>
                        {t('admin.users.changePassword')}
                      </button>
                      {role === 'admin' && u.mfa && (
                        <button className="btn text small" onClick={() => resetMfa(u)}>
                          {t('security.admin.resetMfa')}
                        </button>
                      )}
                      <button
                        className={u.status === 'active' ? 'btn text danger small' : 'btn text small'}
                        onClick={() => patch(u.id, { status: u.status === 'active' ? 'disabled' : 'active' })}
                      >
                        {u.status === 'active' ? t('admin.users.disable') : t('admin.reactivate')}
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
