'use client';

import { type FormEvent, useState } from 'react';
import { useT } from '@/i18n/client';
import { Icon } from '../../ui/Icon';
import { api } from '../../api';
import { messageOf } from '../useLoad';
import { type Base, type Hit, MODE_LABEL, type Trace, kbPath } from './types';

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

export function HitList({ hits, onOpen }: { hits: Hit[]; onOpen: (sourceId: string) => void }) {
  const t = useT();
  return (
    <ol className="kb-hits">
      {hits.map((h, i) => (
        <li key={h.id}>
          <header>
            <span className="kb-rank">{i + 1}</span>
            <strong>
              {h.title}
              {h.section ? <span className="muted"> · {h.section}</span> : null}
            </strong>
            {h.score !== null && (
              <span className="kb-score" title={t('knowledge.search.score', { score: h.score.toFixed(3) })}>
                <span style={{ width: `${Math.round(Math.min(1, Math.max(0, h.score)) * 100)}%` }} />
              </span>
            )}
          </header>
          <p>{h.content}</p>
          <footer className="row">
            {h.score !== null && (
              <span className="muted">{t('knowledge.search.score', { score: h.score.toFixed(3) })}</span>
            )}
            {h.url && (
              <a className="btn text small" href={h.url} target="_blank" rel="noopener noreferrer">
                <Icon name="open_in_new" size={16} />
                {hostOf(h.url)}
              </a>
            )}
            <button type="button" className="btn text small" onClick={() => onOpen(h.sourceId)}>
              <Icon name="description" size={16} />
              {t('knowledge.search.openSource')}
            </button>
          </footer>
        </li>
      ))}
    </ol>
  );
}

/** "Testar a busca": exactly what the assistant would get, and how each step found it. */
export function SearchPanel({ base, onOpen }: { base: Base; onOpen: (sourceId: string) => void }) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ hits: Hit[]; trace: Trace[] } | null>(null);

  async function search(e: FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    setError('');
    try {
      setResult(await api<{ hits: Hit[]; trace: Trace[] }>(`${kbPath(base.id)}/search`, { body: { query } }));
    } catch (err) {
      setError(messageOf(err, t('knowledge.search.couldNotSearch')));
    } finally {
      setBusy(false);
    }
  }

  const trace = result?.trace[0];
  return (
    <>
      <form className="form settings-section panel-form" onSubmit={search} noValidate>
        <div className="row kb-ask">
          <input
            maxLength={1000}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('knowledge.search.placeholder')}
            aria-label={t('knowledge.nav.search')}
          />
          <button className="btn" disabled={busy}>
            <Icon name="search" size={18} />
            {busy ? t('knowledge.search.searching') : t('knowledge.search.button')}
          </button>
        </div>
        <div className="error" role="alert">
          {error}
        </div>
        {trace && (
          <div className="kb-trace" aria-label={t('knowledge.search.trace')}>
            <span className="chip">{t(MODE_LABEL[trace.mode])}</span>
            {trace.expanded && <span className="chip">{t('knowledge.search.expanded')}</span>}
            {trace.mode !== 'keyword' && (
              <span className="chip">{t('knowledge.search.dense', { count: trace.dense })}</span>
            )}
            {trace.mode !== 'semantic' && (
              <span className="chip">{t('knowledge.search.sparse', { count: trace.sparse })}</span>
            )}
            {trace.reranked && <span className="chip accent">{t('knowledge.search.reranked')}</span>}
            <span className="chip">{t('knowledge.search.kept', { count: trace.kept })}</span>
            <span className="chip">{t('knowledge.search.ms', { ms: trace.ms })}</span>
          </div>
        )}
      </form>
      {result && result.hits.length === 0 && <p className="int-empty">{t('knowledge.search.noHits')}</p>}
      {result && result.hits.length > 0 && <HitList hits={result.hits} onOpen={onOpen} />}
    </>
  );
}
