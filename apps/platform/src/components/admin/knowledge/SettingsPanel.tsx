'use client';

import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/keys';
import { api } from '../../api';
import type { Integration } from '../IntegrationsTab';
import { messageOf } from '../useLoad';
import { SourcePicker } from './SourcePicker';
import { embeddingSources, rerankSources } from './sources';
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
  const embeddings = embeddingSources(integrations);
  const rerankers = rerankSources(integrations);
  const [draft, setDraft] = useState({
    name: base.name,
    description: base.description,
    embeddingIntegrationId: base.embeddingIntegrationId ?? '',
    embeddingModel: base.embeddingModel,
    chunkSize: base.chunkSize,
    chunkOverlap: base.chunkOverlap,
    retrievalMode: base.retrievalMode,
    topK: base.topK,
    minScore: base.minScore,
    rerankIntegrationId: base.rerankIntegrationId ?? '',
    rerankModel: base.rerankModel ?? '',
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
    (draft.embeddingIntegrationId || null) !== base.embeddingIntegrationId ||
    (!!draft.embeddingModel && draft.embeddingModel !== base.embeddingModel);

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
          embeddingModel: draft.embeddingModel || undefined,
          rerankIntegrationId: draft.rerankIntegrationId || null,
          rerankModel: draft.rerankIntegrationId ? draft.rerankModel || undefined : null,
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
        <SourcePicker
          label={t('knowledge.settings.embedding')}
          modelLabel={t('knowledge.list.embeddingModelLabel')}
          sources={embeddings}
          integrationId={draft.embeddingIntegrationId}
          model={draft.embeddingModel}
          onChange={(embeddingIntegrationId, embeddingModel) =>
            setDraft({ ...draft, embeddingIntegrationId, embeddingModel })
          }
        />
        <span className="field-help">{t('knowledge.settings.embeddingHelp')}</span>
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
        <SourcePicker
          label={t('knowledge.settings.rerankLabel')}
          modelLabel={t('knowledge.settings.rerankModelLabel')}
          sources={rerankers}
          integrationId={draft.rerankIntegrationId}
          model={draft.rerankModel}
          noneLabel={t('knowledge.settings.rerankNone')}
          onChange={(rerankIntegrationId, rerankModel) =>
            setDraft({ ...draft, rerankIntegrationId, rerankModel })
          }
        />
        {rerankers.length === 0 && (
          <span className="field-help">
            {t('knowledge.settings.noRerank')}{' '}
            <Link href="/admin?tab=integrations">{t('knowledge.list.goIntegrations')}</Link>
          </span>
        )}
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
