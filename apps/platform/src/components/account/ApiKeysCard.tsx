'use client';

import { type FormEvent, useState } from 'react';
import { useLocale, useT } from '@/i18n/client';
import { messageOf, useLoad } from '../admin/useLoad';
import { api } from '../api';
import { Icon } from '../ui/Icon';

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

interface CreatedKey extends ApiKeyRow {
  token: string;
}

/** Create, list and revoke personal API keys (REST + MCP). */
export function ApiKeysCard() {
  const t = useT();
  const locale = useLocale();
  const { data, error, setError, reload } = useLoad<{ keys: ApiKeyRow[] }>('/api/account/api-keys');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<CreatedKey | null>(null);
  const [copied, setCopied] = useState(false);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError('');
    setCopied(false);
    try {
      const { key } = await api<{ key: CreatedKey }>('/api/account/api-keys', {
        body: { name: name.trim() },
      });
      setFresh(key);
      setName('');
      await reload();
    } catch (err) {
      setError(messageOf(err, t('apiKeys.couldNotCreate')));
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke(id: string) {
    if (!window.confirm(t('apiKeys.revokeConfirm'))) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/account/api-keys/${id}`, { method: 'DELETE', body: {} });
      if (fresh?.id === id) setFresh(null);
      await reload();
    } catch (err) {
      setError(messageOf(err, t('apiKeys.couldNotRevoke')));
    } finally {
      setBusy(false);
    }
  }

  async function copyToken() {
    if (!fresh?.token) return;
    try {
      await navigator.clipboard.writeText(fresh.token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const keys = data?.keys ?? [];

  return (
    <section className="settings-section account-card">
      <header className="section-head">
        <h3>
          <Icon name="key" size={20} /> {t('apiKeys.title')}
        </h3>
        <p>{t('apiKeys.intro')}</p>
      </header>

      {fresh && (
        <div className="api-key-secret" role="status">
          <strong>{t('apiKeys.createdTitle')}</strong>
          <p>{t('apiKeys.createdHint')}</p>
          <code className="api-key-token">{fresh.token}</code>
          <div className="save-bar">
            <button type="button" className="btn secondary" onClick={() => void copyToken()}>
              {copied ? t('apiKeys.copied') : t('apiKeys.copy')}
            </button>
          </div>
        </div>
      )}

      <form className="form" onSubmit={(e) => void onCreate(e)}>
        <label>
          {t('apiKeys.nameLabel')}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('apiKeys.namePlaceholder')}
            maxLength={80}
            disabled={busy}
            required
          />
        </label>
        <button type="submit" className="btn" disabled={busy || !name.trim()}>
          <Icon name="key" size={18} />
          {busy ? t('apiKeys.creating') : t('apiKeys.create')}
        </button>
      </form>

      {keys.length === 0 ? (
        <p className="int-empty">{t('apiKeys.empty')}</p>
      ) : (
        <ul className="api-key-list">
          {keys.map((k) => (
            <li key={k.id}>
              <div>
                <strong>{k.name}</strong>
                <p className="field-help">
                  {t('apiKeys.prefix', { prefix: k.prefix })}
                  {' · '}
                  {k.scopes.length === 0
                    ? t('apiKeys.scopesAll')
                    : t('apiKeys.scopesSome', { count: String(k.scopes.length) })}
                  {' · '}
                  {k.lastUsedAt
                    ? t('apiKeys.lastUsed', {
                        date: new Date(k.lastUsedAt).toLocaleString(locale),
                      })
                    : t('apiKeys.neverUsed')}
                </p>
              </div>
              <button
                type="button"
                className="btn secondary"
                disabled={busy}
                onClick={() => void onRevoke(k.id)}
              >
                {t('apiKeys.revoke')}
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="field-help">
        {t('apiKeys.docsHint')}{' '}
        <a href="/developers" target="_blank" rel="noreferrer">
          {t('apiKeys.openDocs')}
        </a>
      </p>
      <div className="error" role="alert">
        {error}
      </div>
    </section>
  );
}
