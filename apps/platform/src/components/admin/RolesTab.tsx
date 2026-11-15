'use client';

import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/i18n/client';
import { ApiError, api } from '../api';
import { Icon } from '../ui/Icon';

interface RoleRow {
  id: string;
  key: string;
  name: string;
  description: string;
  isSystem: boolean;
  permissions: string[];
  userCount: number;
}

interface PermDef {
  code: string;
  category: string;
  description: string;
}

export function RolesTab() {
  const t = useT();
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [defs, setDefs] = useState<PermDef[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newName, setNewName] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await api<{ roles: RoleRow[]; permissions: PermDef[] }>('/api/admin/roles');
      setRoles(data.roles);
      setDefs(data.permissions);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const role = roles.find((r) => r.key === selected);
    setDraft(role ? [...role.permissions] : []);
  }, [selected, roles]);

  async function save() {
    if (!selected) return;
    setBusy(true);
    try {
      await api(`/api/admin/roles/${encodeURIComponent(selected)}`, {
        method: 'PATCH',
        body: { permissions: draft },
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    setBusy(true);
    try {
      await api('/api/admin/roles', {
        method: 'POST',
        body: { key: newKey, name: newName, permissions: draft },
      });
      setCreating(false);
      setNewKey('');
      setNewName('');
      await load();
      setSelected(newKey.trim().toLowerCase());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  async function remove(key: string) {
    if (!confirm(t('admin.roles.confirmDelete', { key }))) return;
    setBusy(true);
    try {
      await api(`/api/admin/roles/${encodeURIComponent(key)}`, { method: 'DELETE' });
      if (selected === key) setSelected(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  const categories = [...new Set(defs.map((d) => d.category))];

  return (
    <div className="admin-stack">
      <header className="admin-head">
        <div>
          <h2>{t('admin.roles.title')}</h2>
          <p className="muted">{t('admin.roles.intro')}</p>
        </div>
        <button className="btn tonal" type="button" onClick={() => setCreating(true)}>
          <Icon name="add" size={20} />
          {t('admin.roles.create')}
        </button>
      </header>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="roles-layout">
        <ul className="roles-list" aria-label={t('admin.roles.list')}>
          {roles.map((r) => (
            <li key={r.key}>
              <button
                type="button"
                className={selected === r.key ? 'role-item active' : 'role-item'}
                onClick={() => {
                  setCreating(false);
                  setSelected(r.key);
                }}
              >
                <strong>{r.name}</strong>
                <small>
                  {r.key}
                  {r.isSystem ? ` · ${t('admin.roles.system')}` : ''} · {r.userCount}
                </small>
              </button>
            </li>
          ))}
        </ul>
        <div className="roles-editor">
          {creating ? (
            <>
              <h3>{t('admin.roles.create')}</h3>
              <label className="field-label">
                {t('admin.roles.key')}
                <input
                  className="field"
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  placeholder="ex_suporte"
                  aria-describedby="role-key-help"
                />
              </label>
              <p id="role-key-help" className="muted small-print">
                {t('admin.roles.keyHelp')}
              </p>
              <label className="field-label">
                {t('admin.roles.name')}
                <input className="field" value={newName} onChange={(e) => setNewName(e.target.value)} />
              </label>
            </>
          ) : selected ? (
            <h3>{roles.find((r) => r.key === selected)?.name}</h3>
          ) : (
            <p className="muted">{t('admin.roles.pick')}</p>
          )}
          {(creating || selected) && (
            <>
              <p className="muted small-print">{t('admin.roles.orgOnly')}</p>
              {categories.map((cat) => (
                <fieldset key={cat} className="perm-group">
                  <legend>{cat}</legend>
                  {defs
                    .filter((d) => d.category === cat)
                    .map((d) => (
                      <label key={d.code} className="check-row">
                        <input
                          type="checkbox"
                          checked={draft.includes(d.code)}
                          onChange={(e) =>
                            setDraft((prev) =>
                              e.target.checked ? [...prev, d.code] : prev.filter((c) => c !== d.code),
                            )
                          }
                        />
                        <span>
                          <strong>{d.code}</strong>
                          <small>{d.description}</small>
                        </span>
                      </label>
                    ))}
                </fieldset>
              ))}
              <div className="row">
                {creating ? (
                  <button className="btn" type="button" disabled={busy || !newKey || !newName} onClick={() => void create()}>
                    {t('common.save')}
                  </button>
                ) : (
                  <>
                    <button className="btn" type="button" disabled={busy} onClick={() => void save()}>
                      {t('common.save')}
                    </button>
                    {selected && !roles.find((r) => r.key === selected)?.isSystem && (
                      <button className="btn text" type="button" disabled={busy} onClick={() => void remove(selected)}>
                        {t('common.delete')}
                      </button>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
