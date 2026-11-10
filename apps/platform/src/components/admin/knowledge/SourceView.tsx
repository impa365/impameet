'use client';

import { useCallback, useEffect, useState } from 'react';
import { serverMessage, useLocale, useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/keys';
import { Icon } from '../../ui/Icon';
import { api } from '../../api';
import { messageOf, useLoad } from '../useLoad';
import { PairsEditor } from './AddSource';
import { Progress, statusDot } from './SourcesPanel';
import {
  type Base,
  KIND_ICON,
  KIND_LABEL,
  type QaPair,
  STATUS_LABEL,
  type SourceDetail,
  type SyncInterval,
  isWorking,
  kbPath,
} from './types';

type Tab = 'chunks' | 'content' | 'pages' | 'history';

interface Chunk {
  id: string;
  idx: number;
  section: string;
  content: string;
  enabled: boolean;
  edited: boolean;
  hits: number;
}

const REASON: Record<SourceDetail['jobs'][number]['reason'], MessageKey> = {
  added: 'knowledge.source.reasonAdded',
  reindex: 'knowledge.source.reasonReindex',
  sync: 'knowledge.source.reasonSync',
  settings: 'knowledge.source.reasonSettings',
};
const JOB: Record<SourceDetail['jobs'][number]['status'], MessageKey> = {
  running: 'knowledge.source.jobRunning',
  done: 'knowledge.source.jobDone',
  failed: 'knowledge.source.jobFailed',
};

/** One source: its pieces, its text (editable for texts and Q&A), its pages and its runs. */
export function SourceView({
  base,
  sourceId,
  onBack,
  onOpen,
  onChanged,
}: {
  base: Base;
  sourceId: string;
  onBack: () => void;
  onOpen: (id: string) => void;
  onChanged: () => Promise<void>;
}) {
  const t = useT();
  const locale = useLocale();
  const path = `${kbPath(base.id)}/sources/${sourceId}`;
  const { data, error, setError, reload } = useLoad<{ source: SourceDetail }>(path);
  const source = data?.source;
  const [tab, setTab] = useState<Tab | null>(null);
  const working = source ? isWorking(source) || source.children.some(isWorking) : false;

  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void reload(), 2500);
    return () => clearInterval(timer);
  }, [working, reload]);

  async function patch(body: Record<string, unknown>) {
    try {
      await api(path, { method: 'PATCH', body });
      await reload();
      void onChanged();
    } catch (err) {
      setError(messageOf(err, t('knowledge.source.couldNotSave')));
    }
  }

  async function remove() {
    if (!source || !window.confirm(t('knowledge.sources.confirmDelete', { name: source.title }))) return;
    try {
      await api(path, { method: 'DELETE', body: {} });
      void onChanged();
      onBack();
    } catch (err) {
      setError(messageOf(err, t('admin.couldNotDelete')));
    }
  }

  if (!source)
    return (
      <div className="error" role="alert">
        {error}
      </div>
    );

  const tabs: [Tab, MessageKey][] = [
    ...(source.kind === 'website' ? ([['pages', 'knowledge.source.tabPages']] as [Tab, MessageKey][]) : []),
    ...(source.kind !== 'website' ? ([['chunks', 'knowledge.source.tabChunks']] as [Tab, MessageKey][]) : []),
    ...(source.kind !== 'website'
      ? ([['content', 'knowledge.source.tabContent']] as [Tab, MessageKey][])
      : []),
    ['history', 'knowledge.source.tabHistory'],
  ];
  const current = tab ?? tabs[0][0];
  const syncable = ['url', 'website', 'youtube'].includes(source.kind);

  return (
    <>
      <button type="button" className="btn text small back-link kb-back" onClick={onBack}>
        <Icon name="arrow_back" size={18} />
        {t('knowledge.source.back')}
      </button>
      <section className="settings-section kb-source-head">
        <div className="tile-head">
          <span className="tile-avatar" aria-hidden>
            <Icon name={KIND_ICON[source.kind]} size={22} />
          </span>
          <div className="tile-title">
            <strong>{source.title}</strong>
            <span className="status-line">
              <span className={statusDot(source)} aria-hidden />
              {source.enabled ? t(STATUS_LABEL[source.status]) : t('knowledge.status.off')} ·{' '}
              {t(KIND_LABEL[source.kind])} · {t('knowledge.sources.chunks', { count: source.chunkCount })}
              {source.kind !== 'website' &&
                ` · ${t('knowledge.sources.chars', { count: source.chars.toLocaleString(locale) })}`}
            </span>
          </div>
        </div>
        {isWorking(source) && <Progress source={source} />}
        {source.error && <p className="error">{serverMessage(source.error)}</p>}
        <div className="error" role="alert">
          {error}
        </div>
        <div className="row kb-source-actions">
          {source.url && (
            <a className="btn secondary small" href={source.url} target="_blank" rel="noopener noreferrer">
              <Icon name="open_in_new" size={16} />
              {t('knowledge.source.open')}
            </a>
          )}
          {source.kind !== 'website' && (
            <a className="btn secondary small" href={`${path}/text`} download>
              <Icon name="download" size={16} />
              {t('knowledge.source.download')}
            </a>
          )}
          <button
            className="btn secondary small"
            disabled={working}
            onClick={() => patch({ reprocess: true })}
          >
            <Icon name="refresh" size={16} />
            {t('knowledge.sources.reprocess')}
          </button>
          <button className="btn secondary small" onClick={() => patch({ enabled: !source.enabled })}>
            <Icon name={source.enabled ? 'visibility_off' : 'visibility'} size={16} />
            {source.enabled ? t('knowledge.sources.disable') : t('knowledge.sources.enable')}
          </button>
          {syncable && (
            <label className="kb-inline-select">
              <Icon name="sync" size={16} />
              <span className="sr-only">{t('knowledge.source.sync')}</span>
              <select
                value={source.syncInterval}
                aria-label={t('knowledge.source.sync')}
                onChange={(e) => patch({ syncInterval: e.target.value as SyncInterval })}
              >
                <option value="off">
                  {t('knowledge.source.sync')}: {t('knowledge.add.syncOff')}
                </option>
                <option value="daily">{t('knowledge.sources.syncDaily')}</option>
                <option value="weekly">{t('knowledge.sources.syncWeekly')}</option>
              </select>
            </label>
          )}
          <button className="btn text danger small" onClick={remove}>
            <Icon name="delete" size={16} />
            {t('common.delete')}
          </button>
        </div>
      </section>

      <div className="seg-tabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={current === id} onClick={() => setTab(id)}>
            {t(label)}
            {id === 'pages' && <span className="seg-count">{source.children.length}</span>}
          </button>
        ))}
      </div>

      {current === 'pages' && <PagesTab source={source} onOpen={onOpen} />}
      {current === 'chunks' && <ChunksTab base={base} source={source} />}
      {current === 'content' && (
        <ContentTab base={base} source={source} onSaved={() => (void reload(), void onChanged())} />
      )}
      {current === 'history' && <HistoryTab source={source} />}
    </>
  );
}

function PagesTab({ source, onOpen }: { source: SourceDetail; onOpen: (id: string) => void }) {
  const t = useT();
  const locale = useLocale();
  return (
    <>
      {source.children.length === 0 ? (
        <p className="int-empty">{t('knowledge.source.noPages')}</p>
      ) : (
        <ul className="item-list">
          {source.children.map((c) => (
            <li key={c.id} className="list-row">
              <div className="list-row-main">
                <strong>
                  <span className={statusDot(c)} aria-hidden />
                  {c.title}
                  <span className="badge">{t(STATUS_LABEL[c.status])}</span>
                  {c.status === 'ready' && (
                    <span className="badge">{t('knowledge.sources.chunks', { count: c.chunkCount })}</span>
                  )}
                </strong>
                <span className="muted">{c.url}</span>
                {c.error && <span className="error">{serverMessage(c.error)}</span>}
              </div>
              <div className="row-actions">
                <button className="btn text small" onClick={() => onOpen(c.id)}>
                  <Icon name="open_in_new" size={16} />
                  {t('knowledge.sources.details')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {source.log.length > 0 && (
        <section className="settings-section">
          <header className="section-head">
            <h3>{t('knowledge.source.activity')}</h3>
          </header>
          <ol className="kb-log">
            {[...source.log].reverse().map((l, i) => (
              <li key={i} className={l.ok ? undefined : 'bad'}>
                <time>{new Date(l.at).toLocaleTimeString(locale)}</time>
                <span>{serverMessage(l.text)}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </>
  );
}

function ChunksTab({ base, source }: { base: Base; source: SourceDetail }) {
  const t = useT();
  const [chunks, setChunks] = useState<Chunk[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const stamp = `${source.processedAt ?? ''}:${source.chunkCount}`;

  const load = useCallback(
    async (offset: number) => {
      try {
        const res = await api<{ total: number; chunks: Chunk[] }>(
          `${kbPath(base.id)}/sources/${source.id}/chunks?offset=${offset}`,
        );
        setTotal(res.total);
        setChunks((prev) => (offset === 0 || !prev ? res.chunks : [...prev, ...res.chunks]));
      } catch (err) {
        setError(messageOf(err, t('common.couldNotLoad')));
      }
    },
    [base.id, source.id, t],
  );

  useEffect(() => {
    void load(0);
  }, [load, stamp]);

  async function patch(chunk: Chunk, body: { enabled?: boolean; content?: string }) {
    setBusy(true);
    try {
      const res = await api<{ chunk: Chunk }>(`${kbPath(base.id)}/chunks/${chunk.id}`, {
        method: 'PATCH',
        body,
      });
      setChunks((prev) => prev?.map((c) => (c.id === chunk.id ? res.chunk : c)) ?? null);
      setEditing(null);
      setError('');
    } catch (err) {
      setError(messageOf(err, t('knowledge.source.couldNotSave')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="error" role="alert">
        {error}
      </div>
      {chunks === null ? null : chunks.length === 0 ? (
        <p className="int-empty">{t('knowledge.source.noChunks')}</p>
      ) : (
        <ol className="kb-chunks">
          {chunks.map((c) => (
            <li key={c.id} className={c.enabled ? 'kb-chunk' : 'kb-chunk is-off'}>
              <header>
                <strong>{t('knowledge.source.chunkN', { n: c.idx + 1 })}</strong>
                {c.section && <span className="muted kb-chunk-section">{c.section}</span>}
                {c.edited && <span className="badge">{t('knowledge.source.edited')}</span>}
                {!c.enabled && <span className="badge warn">{t('knowledge.source.off')}</span>}
                {c.hits > 0 && (
                  <span className="badge primary">{t('knowledge.source.hits', { count: c.hits })}</span>
                )}
                <span className="kb-chunk-tools">
                  <button
                    type="button"
                    className="btn text small icon-only"
                    aria-label={t('knowledge.source.edit')}
                    data-tip={t('knowledge.source.edit')}
                    onClick={() => setEditing({ id: c.id, text: c.content })}
                  >
                    <Icon name="edit" size={16} />
                  </button>
                  <button
                    type="button"
                    className="btn text small icon-only"
                    disabled={busy}
                    aria-label={c.enabled ? t('knowledge.source.turnOff') : t('knowledge.source.turnOn')}
                    data-tip={c.enabled ? t('knowledge.source.turnOff') : t('knowledge.source.turnOn')}
                    onClick={() => patch(c, { enabled: !c.enabled })}
                  >
                    <Icon name={c.enabled ? 'visibility_off' : 'visibility'} size={16} />
                  </button>
                </span>
              </header>
              {editing?.id === c.id ? (
                <div className="form kb-chunk-edit">
                  <textarea
                    rows={8}
                    value={editing.text}
                    maxLength={8000}
                    onChange={(e) => setEditing({ id: c.id, text: e.target.value })}
                    aria-label={t('knowledge.source.chunkN', { n: c.idx + 1 })}
                  />
                  <span className="field-help">{t('knowledge.source.chunkHelp')}</span>
                  <div className="row">
                    <button
                      className="btn small"
                      disabled={busy}
                      onClick={() => patch(c, { content: editing.text })}
                    >
                      {busy ? t('knowledge.source.saving') : t('knowledge.source.saveChunk')}
                    </button>
                    <button className="btn secondary small" onClick={() => setEditing(null)}>
                      {t('common.cancel')}
                    </button>
                  </div>
                </div>
              ) : (
                <p>{c.content}</p>
              )}
            </li>
          ))}
        </ol>
      )}
      {chunks && chunks.length > 0 && (
        <div className="row kb-more">
          <span className="muted">{t('knowledge.source.shown', { shown: chunks.length, total })}</span>
          {chunks.length < total && (
            <button className="btn secondary small" onClick={() => load(chunks.length)}>
              {t('knowledge.source.more')}
            </button>
          )}
        </div>
      )}
    </>
  );
}

function ContentTab({ base, source, onSaved }: { base: Base; source: SourceDetail; onSaved: () => void }) {
  const t = useT();
  const path = `${kbPath(base.id)}/sources/${source.id}`;
  const text = useLoad<{ title: string; text: string }>(`${path}/text?format=json`);
  const [title, setTitle] = useState(source.title);
  const [content, setContent] = useState<string | null>(null);
  const [pairs, setPairs] = useState<QaPair[]>(() =>
    (source.settings.pairs ?? []).map((p) => ({ ...p, active: p.active !== false })),
  );
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const editable = source.kind === 'text' || source.kind === 'qa';

  async function save() {
    setBusy(true);
    setError('');
    try {
      const body: Record<string, unknown> = { title };
      if (source.kind === 'text' && content !== null) body.content = content;
      if (source.kind === 'qa') body.pairs = pairs.filter((p) => p.question.trim() || p.answer.trim());
      await api(path, { method: 'PATCH', body });
      setStatus(t('knowledge.source.saved'));
      onSaved();
    } catch (err) {
      setError(messageOf(err, t('knowledge.source.couldNotSave')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-section">
      {editable && (
        <label>
          {t('knowledge.add.title')}
          <input maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
      )}
      {source.kind === 'qa' ? (
        <>
          <span className="field-help">{t('knowledge.source.qaHelp')}</span>
          <PairsEditor pairs={pairs} onChange={setPairs} withActive />
        </>
      ) : source.kind === 'text' ? (
        <label>
          {t('knowledge.add.content')}
          <textarea
            rows={18}
            value={content ?? text.data?.text ?? ''}
            onChange={(e) => setContent(e.target.value)}
          />
        </label>
      ) : (
        <>
          <span className="field-help">{t('knowledge.source.readOnly')}</span>
          <pre className="kb-text">{text.error || (text.data?.text ?? '…')}</pre>
        </>
      )}
      <div className="error" role="alert">
        {error}
      </div>
      {editable && (
        <div className="row">
          <button className="btn" disabled={busy} onClick={save}>
            {busy ? t('knowledge.source.saving') : t('knowledge.source.saveContent')}
          </button>
          <span className="muted" role="status">
            {status}
          </span>
        </div>
      )}
    </section>
  );
}

function HistoryTab({ source }: { source: SourceDetail }) {
  const t = useT();
  const locale = useLocale();
  if (source.jobs.length === 0) return <p className="int-empty">{t('knowledge.source.noHistory')}</p>;
  return (
    <ul className="item-list">
      {source.jobs.map((j) => (
        <li key={j.id} className="list-row">
          <div className="list-row-main">
            <strong>
              <span
                className={
                  j.status === 'failed'
                    ? 'status-dot bad'
                    : j.status === 'running'
                      ? 'status-dot warn'
                      : 'status-dot'
                }
                aria-hidden
              />
              {t(REASON[j.reason])}
              <span className="badge">{t(JOB[j.status])}</span>
              {j.status === 'done' && (
                <span className="badge">{t('knowledge.sources.chunks', { count: j.chunks })}</span>
              )}
            </strong>
            <span className="muted">
              {new Date(j.startedAt).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'medium' })}
              {j.finishedAt &&
                ` · ${Math.max(0, Math.round((new Date(j.finishedAt).getTime() - new Date(j.startedAt).getTime()) / 100) / 10)} s`}
            </span>
            {j.error && <span className="error">{serverMessage(j.error)}</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}
