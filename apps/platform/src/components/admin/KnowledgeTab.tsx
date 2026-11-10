'use client';

import Link from 'next/link';
import { type FormEvent, useEffect, useState } from 'react';
import { useT } from '@/i18n/client';
import { Icon } from '../ui/Icon';
import { api } from '../api';
import type { Integration } from './IntegrationsTab';
import { BaseView } from './knowledge/BaseView';
import { type Base, type KnowledgeView, MODE_LABEL, urlFor, viewFromUrl } from './knowledge/types';
import { messageOf, useLoad } from './useLoad';

/** Knowledge bases (RAG): what the organization's agents look things up in. */
export function KnowledgeTab() {
  const t = useT();
  const { data, error, setError, reload } = useLoad<{ enabled: boolean; bases: Base[] }>(
    '/api/admin/knowledge',
  );
  const integrations =
    useLoad<{ integrations: Integration[] }>('/api/admin/integrations').data?.integrations ?? [];
  const embeddings = integrations.filter((i) => i.kind === 'embedding');
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ name: '', description: '', embeddingIntegrationId: '' });
  const [view, setView] = useState<KnowledgeView>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setView(viewFromUrl());
    const onPop = () => setView(viewFromUrl());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  function go(next: KnowledgeView) {
    window.history.pushState(null, '', urlFor(next));
    setView(next);
    window.scrollTo({ top: 0 });
  }

  if (data && !data.enabled) return <p className="int-empty">{t('knowledge.list.disabled')}</p>;
  const open = view.kb ? data?.bases.find((b) => b.id === view.kb) : undefined;
  if (view.kb && open)
    return (
      <BaseView
        base={open}
        view={view}
        integrations={integrations}
        go={go}
        onChanged={reload}
        onBack={() => (go({}), void reload())}
      />
    );

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const { base } = await api<{ base: Base }>('/api/admin/knowledge', { body: draft });
      setCreating(false);
      setDraft({ name: '', description: '', embeddingIntegrationId: '' });
      await reload();
      go({ kb: base.id, part: 'add' });
    } catch (err) {
      setError(messageOf(err, t('knowledge.list.couldNotCreate')));
    } finally {
      setBusy(false);
    }
  }

  async function remove(base: Base) {
    if (!window.confirm(t('knowledge.list.confirmDelete', { name: base.name }))) return;
    try {
      await api(`/api/admin/knowledge/${base.id}`, { method: 'DELETE', body: {} });
      await reload();
    } catch (err) {
      setError(messageOf(err, t('admin.couldNotDelete')));
    }
  }

  return (
    <>
      <div className="page-head">
        <p>{t('knowledge.list.intro')}</p>
        {!creating && (
          <button className="btn" onClick={() => setCreating(true)}>
            <Icon name="add" size={18} />
            {t('knowledge.list.newBase')}
          </button>
        )}
      </div>
      <div className="error" role="alert">
        {error}
      </div>
      {creating && (
        <form onSubmit={create} className="form settings-section panel-form" noValidate>
          <header className="section-head">
            <h3>{t('knowledge.list.newBase')}</h3>
          </header>
          <label>
            {t('knowledge.list.nameLabel')}
            <input
              maxLength={80}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label>
            {t('knowledge.list.descriptionLabel')}
            <input
              maxLength={500}
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </label>
          <label>
            {t('knowledge.list.embeddingLabel')}
            <select
              value={draft.embeddingIntegrationId}
              onChange={(e) => setDraft({ ...draft, embeddingIntegrationId: e.target.value })}
            >
              <option value="" disabled>
                {t('admin.agents.choose')}
              </option>
              {embeddings.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name} · {i.defaultModel}
                </option>
              ))}
            </select>
            {embeddings.length === 0 && (
              <span className="field-help">
                {t('knowledge.list.noEmbedding')}{' '}
                <Link href="/admin?tab=integrations">{t('knowledge.list.goIntegrations')}</Link>
              </span>
            )}
            <span className="field-help">{t('knowledge.list.embeddingHelp')}</span>
          </label>
          <div className="row">
            <button className="btn" disabled={busy}>
              {busy ? t('knowledge.list.creating') : t('knowledge.list.create')}
            </button>
            <button type="button" className="btn secondary" onClick={() => setCreating(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </form>
      )}
      {data?.bases.length === 0 && !creating && <p className="int-empty">{t('knowledge.list.empty')}</p>}
      {(data?.bases.length ?? 0) > 0 && (
        <ul className="card-list">
          {data?.bases.map((b) => (
            <li key={b.id} className="tile">
              <div className="tile-body">
                <div className="tile-head">
                  <span className="tile-avatar" aria-hidden>
                    <Icon name="menu_book" size={22} />
                  </span>
                  <div className="tile-title">
                    <strong>{b.name}</strong>
                    <span className="muted">
                      {b.embeddingModel} · {b.dimensions}d
                    </span>
                  </div>
                </div>
                <span className="tile-status status-line">
                  <span
                    className={
                      b.working > 0 ? 'status-dot warn' : b.failed > 0 ? 'status-dot bad' : 'status-dot'
                    }
                    aria-hidden
                  />
                  {b.working > 0 ? t('knowledge.list.working') : t('knowledge.status.ready')}
                </span>
                {b.description && <p className="tile-text">{b.description}</p>}
                <dl className="tile-facts">
                  <div>
                    <dt>
                      <Icon name="description" size={16} />
                      {t('knowledge.list.sources')}
                    </dt>
                    <dd>{b.sources}</dd>
                  </div>
                  <div>
                    <dt>
                      <Icon name="category" size={16} />
                      {t('knowledge.list.chunks')}
                    </dt>
                    <dd>{b.chunks}</dd>
                  </div>
                  <div>
                    <dt>
                      <Icon name="search" size={16} />
                      {t('knowledge.list.search')}
                    </dt>
                    <dd>{t(MODE_LABEL[b.retrievalMode])}</dd>
                  </div>
                  <div>
                    <dt>
                      <Icon name="smart_toy" size={16} />
                      {t('knowledge.list.agents')}
                    </dt>
                    <dd>{b.agents}</dd>
                  </div>
                </dl>
              </div>
              <div className="tile-actions">
                <button className="btn text small" onClick={() => go({ kb: b.id })}>
                  <Icon name="open_in_new" size={16} />
                  {t('knowledge.list.open')}
                </button>
                <button
                  className="btn text danger small icon-only"
                  aria-label={t('knowledge.list.deleteNamed', { name: b.name })}
                  data-tip={t('common.delete')}
                  onClick={() => remove(b)}
                >
                  <Icon name="delete" size={16} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
