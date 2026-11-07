'use client';

import { type FormEvent, useState } from 'react';
import { useLocale, useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/keys';
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
  const roles: Role[] = role === 'admin' ? ['member', 'manager', 'admin'] : ['member'];
  const canEdit = (u: User) => u.id !== selfId && (role === 'admin' || u.role === 'member');

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/api/admin/users', { body: form });
      setForm({ name: '', email: '', password: '', role: 'member' });
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

  async function resetPassword(u: User) {
    const password = window.prompt(t('admin.users.newPasswordPrompt', { name: u.name }));
    if (password) await patch(u.id, { password });
  }

  return (
    <>
      <form onSubmit={create} className="card form" style={{ maxWidth: 'none', marginBottom: 20 }}>
        <strong>{t('admin.users.newUser')}</strong>
        <div className="row">
          <input
            required
            placeholder={t('admin.users.name')}
            maxLength={80}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <input
            required
            type="email"
            placeholder={t('admin.users.email')}
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
          <input
            required
            type="password"
            placeholder={t('admin.users.initialPassword')}
            minLength={10}
            autoComplete="new-password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
          <select
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value as Role })}
            style={{ maxWidth: 140 }}
          >
            {roles.map((r) => (
              <option key={r} value={r}>
                {t(ROLE_LABEL[r])}
              </option>
            ))}
          </select>
          <button className="btn" disabled={busy}>
            {t('common.create')}
          </button>
        </div>
      </form>
      <div className="error" role="alert">
        {error}
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th>{t('admin.users.name')}</th>
            <th>{t('admin.users.email')}</th>
            <th>{t('admin.users.role')}</th>
            <th>{t('admin.status')}</th>
            <th>{t('admin.users.lastAccess')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data?.users.map((u) => (
            <tr key={u.id}>
              <td>{u.name}</td>
              <td>{u.email}</td>
              <td>
                {canEdit(u) ? (
                  <select value={u.role} onChange={(e) => patch(u.id, { role: e.target.value })}>
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
              <td>{u.status === 'active' ? t('admin.users.active') : t('admin.users.disabled')}</td>
              <td className="muted">
                {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString(locale) : '—'}
              </td>
              <td>
                {canEdit(u) && (
                  <span className="row">
                    <button className="btn secondary small" onClick={() => resetPassword(u)}>
                      {t('admin.users.changePassword')}
                    </button>
                    <button
                      className={u.status === 'active' ? 'btn danger small' : 'btn small'}
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
    </>
  );
}
