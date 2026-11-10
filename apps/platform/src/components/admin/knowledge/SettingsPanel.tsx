'use client';

import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/keys';
import { api } from '../../api';
import type { Integration } from '../IntegrationsTab';
import { messageOf } from '../useLoad';
import { type Base, type RetrievalMode, kbPath } from './types';

const MODES: [RetrievalMode, MessageKey, MessageKey][] = [
  ['hybrid', 'knowledge.settings.modeHybrid', 'knowledge.settings.modeHybridHint'],
  ['semantic', 'knowledge.settings.modeSemantic', 'knowledge.settings.modeSemanticHint'],
  ['keyword', 'knowledge.settings.modeKeyword', 'knowledge.settings.modeKeywordHint'],
];

/** How the base cuts its texts, searches and reranks, and which model gives meaning to them. */
export function SettingsPanel({
  base,
  integrations,
  onSaved,
}: {
  base: Base;
  integrations: Integration[];
  onSaved: () => Promise<void>;
}) {
  const t = useT();
  const embeddings = integrations.filter((i) => i.kind === 'embedding');
  const rerankers = integrations.filter((i) => i.kind === 'rerank');
  const [draft, setDraft] = useState({
    name: base.name,
    description: base.description,
    embeddingIntegrationId: base.embeddingIntegrationId ?? '',
    chunkSize: base.chunkSize,
    chunkOverlap: base.chunkOverlap,
    retrievalMode: base.retrievalMode,
    topK: base.topK,
    minScore: base.minScore,
    rerankIntegrationId: base.rerankIntegrationId ?? '',
    expandQueries: base.expandQueries,
  });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const set = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) =>
    setDraft({ ...draft, [key]: value });
  const reindex =
    draft.chunkSize !== base.chunkSize ||
    draft.chunkOverlap !== base.chunkOverlap ||
    (draft.embeddingIntegrationId || null) !== base.embeddingIntegrationId;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (reindex && !window.confirm(t('knowledge.settings.confirmReindex'))) return;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await api(kbPath(base.id), {
        method: 'PATCH',
        body: {
          ...draft,
          embeddingIntegrationId: draft.embeddingIntegrationId || undefined,
          rerankIntegrationId: draft.rerankIntegrationId || null,
        },
      });
      setStatus(reindex ? t('knowledge.settings.savedReindex') : t('knowledge.settings.saved'));
      await onSaved();
    } catch (err) {
      setError(messageOf(err, t('knowledge.settings.couldNotSave')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form settings-form" onSubmit={save} noValidate>
      <section className="settings-section">
        <header className="section-head">
          <h3>{t('knowledge.settings.general')}</h3>
        </header>
        <label>
          {t('knowledge.list.nameLabel')}
          <input maxLength={80} value={draft.name} onChange={(e) => set('name', e.target.value)} />
        </label>
        <label>
          {t('knowledge.list.descriptionLabel')}
          <input
            maxLength={500}
            value={draft.description}
            onChange={(e) => set('description', e.target.value)}
          />
        </label>
        <label>
          {t('knowledge.settings.embedding')}
          <select
            value={draft.embeddingIntegrationId}
            onChange={(e) => set('embeddingIntegrationId', e.target.value)}
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
          <span className="field-help">{t('knowledge.settings.embeddingHelp')}</span>
        </label>
      </section>

      <section className="settings-section">
        <header className="section-head">
          <h3>{t('knowledge.settings.cutting')}</h3>
          <p>{t('knowledge.settings.cuttingHint')}</p>
        </header>
        <div className="fields">
          <label>
            {t('knowledge.settings.chunkSize')}
            <input
              type="number"
              min={200}
              max={4000}
              step={50}
              value={draft.chunkSize}
              onChange={(e) => set('chunkSize', Number(e.target.value))}
            />
            <span className="field-help">{t('knowledge.settings.chunkSizeHelp')}</span>
          </label>
          <label>
            {t('knowledge.settings.chunkOverlap')}
            <input
              type="number"
              min={0}
              max={1000}
              step={10}
              value={draft.chunkOverlap}
              onChange={(e) => set('chunkOverlap', Number(e.target.value))}
            />
            <span className="field-help">{t('knowledge.settings.chunkOverlapHelp')}</span>
          </label>
        </div>
      </section>

      <section className="settings-section">
        <header className="section-head">
          <h3>{t('knowledge.settings.searching')}</h3>
        </header>
        <fieldset className="plain kb-modes">
          <legend>{t('knowledge.settings.mode')}</legend>
          {MODES.map(([mode, label, hint]) => (
            <label key={mode} className={draft.retrievalMode === mode ? 'kb-mode selected' : 'kb-mode'}>
              <input
                type="radio"
                name="retrievalMode"
                checked={draft.retrievalMode === mode}
                onChange={() => set('retrievalMode', mode)}
              />
              <span>
                <strong>{t(label)}</strong>
                <small>{t(hint)}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="fields">
          <label>
            {t('knowledge.settings.topK')}
            <input
              type="number"
              min={1}
              max={20}
              value={draft.topK}
              onChange={(e) => set('topK', Number(e.target.value))}
            />
            <span className="field-help">{t('knowledge.settings.topKHelp')}</span>
          </label>
          <label>
            {t('knowledge.settings.minScore')} · {draft.minScore.toFixed(2)}
            <input
              type="range"
              min={0}
              max={0.9}
              step={0.05}
              value={draft.minScore}
              disabled={draft.retrievalMode === 'keyword'}
              onChange={(e) => set('minScore', Number(e.target.value))}
            />
            <span className="field-help">{t('knowledge.settings.minScoreHelp')}</span>
          </label>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            checked={draft.expandQueries}
            disabled={draft.retrievalMode === 'keyword'}
            onChange={(e) => set('expandQueries', e.target.checked)}
          />
          <span>
            {t('knowledge.settings.expand')}
            <small>{t('knowledge.settings.expandHelp')}</small>
          </span>
        </label>
      </section>

      <section className="settings-section">
        <header className="section-head">
          <h3>{t('knowledge.settings.rerank')}</h3>
          <p>{t('knowledge.settings.rerankHelp')}</p>
        </header>
        <label>
          {t('knowledge.settings.rerankLabel')}
          <select
            value={draft.rerankIntegrationId}
            onChange={(e) => set('rerankIntegrationId', e.target.value)}
          >
            <option value="">{t('knowledge.settings.rerankNone')}</option>
            {rerankers.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name} · {i.defaultModel}
              </option>
            ))}
          </select>
          {rerankers.length === 0 && (
            <span className="field-help">
              {t('knowledge.settings.noRerank')}{' '}
              <Link href="/admin?tab=integrations">{t('knowledge.list.goIntegrations')}</Link>
            </span>
          )}
        </label>
      </section>

      <div className="save-bar">
        <button className="btn" disabled={busy}>
          {busy ? t('knowledge.settings.saving') : t('knowledge.settings.save')}
        </button>
        <span className="muted" role="status">
          {status}
        </span>
        <div className="error" role="alert">
          {error}
        </div>
      </div>
    </form>
  );
}
