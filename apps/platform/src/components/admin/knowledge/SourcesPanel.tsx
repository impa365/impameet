'use client';

import { useEffect, useState } from 'react';
import { serverMessage, useLocale, useT } from '@/i18n/client';
import { Icon } from '../../ui/Icon';
import { api } from '../../api';
import { messageOf, useLoad } from '../useLoad';
import {
  type Base,
  KIND_ICON,
  KIND_LABEL,
  STATUS_LABEL,
  STEP_LABEL,
  type Source,
  type SourceKind,
  isWorking,
  kbPath,
} from './types';

export function statusDot(s: Pick<Source, 'status' | 'enabled'>) {
  if (!s.enabled) return 'status-dot idle';
  if (s.status === 'failed') return 'status-dot bad';
  if (isWorking(s)) return 'status-dot warn';
  return 'status-dot';
}

/** Progress of an indexing run: the step it is in and how far along. */
export function Progress({ source }: { source: Pick<Source, 'progress' | 'step' | 'status'> }) {
  const t = useT();
  const step = STEP_LABEL[source.step];
  return (
    <div className="kb-progress">
      <div
        className="kb-progress-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={source.progress}
      >
        <span style={{ width: `${Math.max(4, source.progress)}%` }} />
      </div>
      <span className="muted">
        {step ? t(step) : source.step || t(STATUS_LABEL[source.status])} · {source.progress}%
      </span>
    </div>
  );
}

/** The sources of a base as cards, refreshing while something is being indexed. */
export function SourcesPanel({
  base,
  onAdd,
  onOpen,
  onChanged,
}: {
  base: Base;
  onAdd: () => void;
  onOpen: (id: string) => void;
  onChanged: () => Promise<void>;
}) {
  const t = useT();
  const locale = useLocale();
  const path = kbPath(base.id);
  const { data, error, setError, reload } = useLoad<{ sources: Source[] }>(`${path}/sources`);
  const [filter, setFilter] = useState<SourceKind | 'all'>('all');
  const sources = data?.sources ?? [];
  const working = sources.some(isWorking);

  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void reload(), 2500);
    return () => clearInterval(timer);
  }, [working, reload]);

  async function patch(s: Source, body: Record<string, unknown>) {
    try {
      await api(`${path}/sources/${s.id}`, { method: 'PATCH', body });
      await reload();
      void onChanged();
    } catch (err) {
      setError(messageOf(err, t('admin.couldNotSave')));
    }
  }

  async function remove(s: Source) {
    if (!window.confirm(t('knowledge.sources.confirmDelete', { name: s.title }))) return;
    try {
      await api(`${path}/sources/${s.id}`, { method: 'DELETE', body: {} });
      await reload();
      void onChanged();
    } catch (err) {
      setError(messageOf(err, t('admin.couldNotDelete')));
    }
  }

  const kinds = [...new Set(sources.map((s) => s.kind))];
  const shown = filter === 'all' ? sources : sources.filter((s) => s.kind === filter);
  const subtitle = (s: Source) =>
    s.kind === 'website'
      ? t('knowledge.sources.pages', { count: s.pages })
      : (s.url ?? s.fileName ?? t('knowledge.sources.chars', { count: s.chars.toLocaleString(locale) }));

  return (
    <>
      <div className="error" role="alert">
        {error}
      </div>
      {data && sources.length === 0 && (
        <div className="int-empty kb-empty">
          <span>{t('knowledge.sources.empty')}</span>
          <button className="btn small" onClick={onAdd}>
            <Icon name="add" size={16} />
            {t('knowledge.sources.addFirst')}
          </button>
        </div>
      )}
      {kinds.length > 1 && (
        <div className="chips" role="group" aria-label={t('knowledge.sources.filter')}>
          <button
            type="button"
            className={filter === 'all' ? 'chip add accent' : 'chip add'}
            aria-pressed={filter === 'all'}
            onClick={() => setFilter('all')}
          >
            {t('knowledge.sources.all')} · {sources.length}
          </button>
          {kinds.map((k) => (
            <button
              key={k}
              type="button"
              className={filter === k ? 'chip add accent' : 'chip add'}
              aria-pressed={filter === k}
              onClick={() => setFilter(k)}
            >
              {t(KIND_LABEL[k])} · {sources.filter((s) => s.kind === k).length}
            </button>
          ))}
        </div>
      )}
      {shown.length > 0 && (
        <ul className="card-list" aria-live="polite">
          {shown.map((s) => (
            <li key={s.id} className={s.enabled ? 'tile' : 'tile is-off'}>
              <div className="tile-body">
                <div className="tile-head">
                  <span className="tile-avatar" aria-hidden>
                    <Icon name={KIND_ICON[s.kind]} size={22} />
                  </span>
                  <div className="tile-title">
                    <strong>{s.title}</strong>
                    <span className="muted" title={subtitle(s)}>
                      {subtitle(s)}
                    </span>
                  </div>
                </div>
                <span className="tile-status status-line">
                  <span className={statusDot(s)} aria-hidden />
                  {s.enabled ? t(STATUS_LABEL[s.status]) : t('knowledge.status.off')}
                </span>
                {isWorking(s) && <Progress source={s} />}
                {s.error && <p className="error tile-error">{serverMessage(s.error)}</p>}
                <dl className="tile-facts">
                  <div>
                    <dt>
                      <Icon name={KIND_ICON[s.kind]} size={16} />
                      {t('knowledge.source.kind')}
                    </dt>
                    <dd>{t(KIND_LABEL[s.kind])}</dd>
                  </div>
                  <div>
                    <dt>
                      <Icon name="category" size={16} />
                      {t('knowledge.source.chunks')}
                    </dt>
                    <dd>{s.chunkCount.toLocaleString(locale)}</dd>
                  </div>
                  {s.syncInterval !== 'off' && (
                    <div>
                      <dt>
                        <Icon name="sync" size={16} />
                        {t('knowledge.source.sync')}
                      </dt>
                      <dd>
                        {s.syncInterval === 'daily'
                          ? t('knowledge.sources.syncDaily')
                          : t('knowledge.sources.syncWeekly')}
                      </dd>
                    </div>
                  )}
                  {s.processedAt && (
                    <div>
                      <dt>
                        <Icon name="history" size={16} />
                        {t('knowledge.sources.lastIndexed')}
                      </dt>
                      <dd>
                        {new Date(s.processedAt).toLocaleString(locale, {
                          dateStyle: 'short',
                          timeStyle: 'short',
                        })}
                      </dd>
                    </div>
                  )}
                </dl>
              </div>
              <div className="tile-actions">
                <button className="btn text small" onClick={() => onOpen(s.id)}>
                  <Icon name="open_in_new" size={16} />
                  {t('knowledge.sources.details')}
                </button>
                <button
                  className="btn text small icon-only"
                  disabled={isWorking(s)}
                  aria-label={t('knowledge.sources.reprocess')}
                  data-tip={t('knowledge.sources.reprocess')}
                  onClick={() => patch(s, { reprocess: true })}
                >
                  <Icon name="refresh" size={16} />
                </button>
                <button className="btn text small" onClick={() => patch(s, { enabled: !s.enabled })}>
                  <Icon name={s.enabled ? 'visibility_off' : 'visibility'} size={16} />
                  {s.enabled ? t('knowledge.sources.disable') : t('knowledge.sources.enable')}
                </button>
                <button
                  className="btn text danger small icon-only"
                  aria-label={t('knowledge.sources.deleteNamed', { name: s.title })}
                  data-tip={t('common.delete')}
                  onClick={() => remove(s)}
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
