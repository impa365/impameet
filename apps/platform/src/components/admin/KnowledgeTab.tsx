'use client';

import Link from 'next/link';
import { type FormEvent, useEffect, useState } from 'react';
import { serverMessage, useLocale, useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/keys';
import { api } from '../api';
import type { Integration } from './IntegrationsTab';
import { messageOf, useLoad } from './useLoad';

interface Base {
  id: string;
  name: string;
  description: string;
  embeddingModel: string;
  dimensions: number;
  sources: number;
  chunks: number;
  agents: number;
}

interface Source {
  id: string;
  kind: 'text' | 'file' | 'url' | 'qa';
  title: string;
  url: string | null;
  status: 'queued' | 'processing' | 'ready' | 'failed';
  error: string | null;
  chunkCount: number;
  enabled: boolean;
  chars: number;
}

interface Hit {
  base: string;
  title: string;
  section: string;
  content: string;
}

type Adding = 'text' | 'qa' | 'url' | 'file' | null;

const STATUS: Record<Source['status'], MessageKey> = {
  queued: 'admin.knowledge.statusQueued',
  processing: 'admin.knowledge.statusProcessing',
  ready: 'admin.knowledge.statusReady',
  failed: 'admin.knowledge.statusFailed',
};
const KIND: Record<Source['kind'], MessageKey> = {
  text: 'admin.knowledge.kindText',
  file: 'admin.knowledge.kindFile',
  url: 'admin.knowledge.kindUrl',
  qa: 'admin.knowledge.kindQa',
};

/** Knowledge bases (RAG): documents the organization's agents look things up in. */
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
  const [open, setOpen] = useState<Base | null>(null);
  const [busy, setBusy] = useState(false);

  if (data && !data.enabled) return <p className="muted">{t('admin.knowledge.disabled')}</p>;
  if (open) return <BaseView base={open} onBack={() => (setOpen(null), void reload())} />;

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/api/admin/knowledge', { body: draft });
      setCreating(false);
      setDraft({ name: '', description: '', embeddingIntegrationId: '' });
      await reload();
    } catch (err) {
      setError(messageOf(err, t('admin.knowledge.couldNotCreate')));
    } finally {
      setBusy(false);
    }
  }

  async function remove(base: Base) {
    if (!window.confirm(t('admin.knowledge.confirmDelete', { name: base.name }))) return;
    try {
      await api(`/api/admin/knowledge/${base.id}`, { method: 'DELETE', body: {} });
      await reload();
    } catch (err) {
      setError(messageOf(err, t('admin.couldNotDelete')));
    }
  }

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
        <p className="muted" style={{ margin: 0, maxWidth: 680 }}>
          {t('admin.knowledge.intro')}
        </p>
        {!creating && (
          <button className="btn" onClick={() => setCreating(true)}>
            {t('admin.knowledge.newBase')}
          </button>
        )}
      </div>
      <div className="error" role="alert">
        {error}
      </div>
      {creating && (
        <form onSubmit={create} className="card form" style={{ maxWidth: 640, margin: '0 0 16px' }}>
          <strong>{t('admin.knowledge.newBase')}</strong>
          <label>
            {t('admin.knowledge.nameLabel')}
            <input
              required
              maxLength={80}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label>
            {t('admin.knowledge.descriptionLabel')}
            <input
              maxLength={500}
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </label>
          <label>
            {t('admin.knowledge.embeddingLabel')}
            <select
              required
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
              <span className="muted">
                {t('admin.knowledge.noEmbedding')}{' '}
                <Link href="/admin?tab=integrations">{t('admin.knowledge.goIntegrations')}</Link>
              </span>
            )}
            <span className="muted small-print">{t('admin.knowledge.embeddingHelp')}</span>
          </label>
          <div className="row">
            <button className="btn" disabled={busy}>
              {busy ? t('admin.knowledge.creating') : t('admin.knowledge.create')}
            </button>
            <button type="button" className="btn secondary" onClick={() => setCreating(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </form>
      )}
      {data?.bases.length === 0 && !creating && <p className="muted">{t('admin.knowledge.empty')}</p>}
      <ul className="rooms">
        {data?.bases.map((b) => (
          <li key={b.id}>
            <div>
              <strong>{b.name}</strong>
              <span className="badge">{t('admin.knowledge.sourcesBadge', { count: b.sources })}</span>
              <span className="badge">{t('admin.knowledge.chunksBadge', { count: b.chunks })}</span>
              <span className="badge">🤖 {b.agents}</span>
              <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
                {b.description || b.embeddingModel} · {b.dimensions}d
              </div>
            </div>
            <div className="row">
              <button className="btn secondary small" onClick={() => setOpen(b)}>
                {t('admin.knowledge.open')}
              </button>
              <button className="btn danger small" onClick={() => remove(b)}>
                {t('common.delete')}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

function BaseView({ base, onBack }: { base: Base; onBack: () => void }) {
  const t = useT();
  const locale = useLocale();
  const path = `/api/admin/knowledge/${base.id}`;
  const { data, error, setError, reload } = useLoad<{ sources: Source[] }>(`${path}/sources`);
  const [adding, setAdding] = useState<Adding>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState({ title: '', content: '' });
  const [url, setUrl] = useState({ url: '', title: '' });
  const [pairs, setPairs] = useState([{ question: '', answer: '' }]);
  const [qaTitle, setQaTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);

  const working = data?.sources.some((s) => s.status === 'queued' || s.status === 'processing');
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void reload(), 3000);
    return () => clearInterval(timer);
  }, [working, reload]);

  async function send(body: unknown) {
    setBusy(true);
    try {
      await api(`${path}/sources`, { body });
      setAdding(null);
      await reload();
    } catch (err) {
      setError(messageOf(err, t('admin.knowledge.couldNotAdd')));
    } finally {
      setBusy(false);
    }
  }

  async function upload(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`${path}/sources`, { method: 'POST', body: form, credentials: 'same-origin' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(serverMessage(body.error?.message ?? t('admin.knowledge.couldNotAdd')));
      }
      setFile(null);
      setAdding(null);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.knowledge.couldNotAdd'));
    } finally {
      setBusy(false);
    }
  }

  async function patch(s: Source, body: Record<string, unknown>) {
    try {
      await api(`${path}/sources/${s.id}`, { method: 'PATCH', body });
      await reload();
    } catch (err) {
      setError(messageOf(err, t('admin.couldNotSave')));
    }
  }

  async function remove(s: Source) {
    if (!window.confirm(t('admin.knowledge.confirmDeleteSource', { name: s.title }))) return;
    try {
      await api(`${path}/sources/${s.id}`, { method: 'DELETE', body: {} });
      await reload();
    } catch (err) {
      setError(messageOf(err, t('admin.couldNotDelete')));
    }
  }

  async function search(e: FormEvent) {
    e.preventDefault();
    setHits(null);
    try {
      setHits((await api<{ hits: Hit[] }>(`${path}/search`, { body: { query } })).hits);
    } catch (err) {
      setError(messageOf(err, t('admin.knowledge.couldNotSearch')));
    }
  }

  return (
    <section>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <button className="btn text" onClick={onBack}>
            ← {t('admin.knowledge.back')}
          </button>
          <h3 style={{ margin: '4px 0' }}>{base.name}</h3>
          <span className="muted">
            {base.embeddingModel} · {base.dimensions}d
          </span>
        </div>
        <div className="row">
          {(['text', 'file', 'url', 'qa'] as const).map((k) => (
            <button key={k} className="btn secondary small" onClick={() => setAdding(k)}>
              + {t(KIND[k])}
            </button>
          ))}
        </div>
      </div>
      <div className="error" role="alert">
        {error}
      </div>

      {adding === 'text' && (
        <form
          className="card form"
          onSubmit={(e) => (e.preventDefault(), void send({ kind: 'text', ...text }))}
          style={{ maxWidth: 760 }}
        >
          <label>
            {t('admin.knowledge.titleLabel')}
            <input
              required
              maxLength={200}
              value={text.title}
              onChange={(e) => setText({ ...text, title: e.target.value })}
            />
          </label>
          <label>
            {t('admin.knowledge.contentLabel')}
            <textarea
              required
              rows={10}
              value={text.content}
              onChange={(e) => setText({ ...text, content: e.target.value })}
              placeholder={t('admin.knowledge.contentPlaceholder')}
            />
            <span className="muted small-print">{t('admin.knowledge.contentHelp')}</span>
          </label>
          <FormButtons busy={busy} onCancel={() => setAdding(null)} />
        </form>
      )}
      {adding === 'url' && (
        <form
          className="card form"
          onSubmit={(e) => (e.preventDefault(), void send({ kind: 'url', ...url }))}
          style={{ maxWidth: 760 }}
        >
          <label>
            {t('admin.knowledge.urlLabel')}
            <input
              required
              type="url"
              placeholder="https://suaempresa.com/precos"
              value={url.url}
              onChange={(e) => setUrl({ ...url, url: e.target.value })}
            />
            <span className="muted small-print">{t('admin.knowledge.urlHelp')}</span>
          </label>
          <label>
            {t('admin.knowledge.titleOptional')}
            <input
              maxLength={200}
              value={url.title}
              onChange={(e) => setUrl({ ...url, title: e.target.value })}
            />
          </label>
          <FormButtons busy={busy} onCancel={() => setAdding(null)} />
        </form>
      )}
      {adding === 'file' && (
        <form className="card form" onSubmit={upload} style={{ maxWidth: 760 }}>
          <label>
            {t('admin.knowledge.fileLabel')}
            <input
              required
              type="file"
              accept=".pdf,.docx,.txt,.md,.markdown,.csv,.html,.htm,.json"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <span className="muted small-print">{t('admin.knowledge.fileHelp')}</span>
          </label>
          <FormButtons busy={busy} onCancel={() => setAdding(null)} />
        </form>
      )}
      {adding === 'qa' && (
        <form
          className="card form"
          onSubmit={(e) => (
            e.preventDefault(),
            void send({
              kind: 'qa',
              title: qaTitle,
              pairs: pairs.filter((p) => p.question.trim() && p.answer.trim()),
            })
          )}
          style={{ maxWidth: 760 }}
        >
          <label>
            {t('admin.knowledge.titleLabel')}
            <input
              required
              maxLength={200}
              value={qaTitle}
              onChange={(e) => setQaTitle(e.target.value)}
              placeholder="FAQ"
            />
          </label>
          {pairs.map((p, i) => (
            <fieldset className="group" key={i}>
              <legend>{t('admin.knowledge.pairN', { n: i + 1 })}</legend>
              <label>
                {t('admin.knowledge.question')}
                <input
                  maxLength={1000}
                  value={p.question}
                  onChange={(e) =>
                    setPairs(pairs.map((x, j) => (j === i ? { ...x, question: e.target.value } : x)))
                  }
                />
              </label>
              <label>
                {t('admin.knowledge.answer')}
                <textarea
                  rows={2}
                  maxLength={5000}
                  value={p.answer}
                  onChange={(e) =>
                    setPairs(pairs.map((x, j) => (j === i ? { ...x, answer: e.target.value } : x)))
                  }
                />
              </label>
            </fieldset>
          ))}
          <button
            type="button"
            className="btn secondary small"
            onClick={() => setPairs([...pairs, { question: '', answer: '' }])}
          >
            {t('admin.knowledge.addPair')}
          </button>
          <FormButtons busy={busy} onCancel={() => setAdding(null)} />
        </form>
      )}

      {data?.sources.length === 0 && <p className="muted">{t('admin.knowledge.noSources')}</p>}
      <ul className="rooms" aria-live="polite">
        {data?.sources.map((s) => (
          <li key={s.id}>
            <div>
              <strong>{s.title}</strong> <span className="badge">{t(KIND[s.kind])}</span>
              <span className={`badge${s.status === 'failed' ? ' warn' : ''}`}>{t(STATUS[s.status])}</span>
              {s.status === 'ready' && (
                <span className="badge">{t('admin.knowledge.chunksBadge', { count: s.chunkCount })}</span>
              )}
              {!s.enabled && <span className="badge warn">{t('admin.knowledge.off')}</span>}
              <div className="muted" style={{ fontSize: 13, marginTop: 4, wordBreak: 'break-all' }}>
                {s.url ?? t('admin.knowledge.chars', { count: s.chars.toLocaleString(locale) })}
              </div>
              {s.error && <div className="error">{serverMessage(s.error)}</div>}
            </div>
            <div className="row">
              <button className="btn secondary small" onClick={() => patch(s, { enabled: !s.enabled })}>
                {s.enabled ? t('admin.knowledge.disable') : t('admin.knowledge.enable')}
              </button>
              <button className="btn secondary small" onClick={() => patch(s, { reprocess: true })}>
                {t('admin.knowledge.reprocess')}
              </button>
              <button className="btn danger small" onClick={() => remove(s)}>
                {t('common.delete')}
              </button>
            </div>
          </li>
        ))}
      </ul>

      <form className="card form" onSubmit={search} style={{ maxWidth: 760, marginTop: 16 }}>
        <strong>{t('admin.knowledge.testTitle')}</strong>
        <div className="row">
          <input
            style={{ flex: 1 }}
            required
            maxLength={1000}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('admin.knowledge.testPlaceholder')}
            aria-label={t('admin.knowledge.testTitle')}
          />
          <button className="btn">{t('admin.knowledge.testButton')}</button>
        </div>
        {hits && hits.length === 0 && <p className="muted">{t('admin.knowledge.noHits')}</p>}
        {hits && hits.length > 0 && (
          <ol className="copilot-answers">
            {hits.map((h, i) => (
              <li key={i}>
                <strong>
                  {h.title}
                  {h.section ? ` · ${h.section}` : ''}
                </strong>
                <p>{h.content}</p>
              </li>
            ))}
          </ol>
        )}
      </form>
    </section>
  );
}

function FormButtons({ busy, onCancel }: { busy: boolean; onCancel: () => void }) {
  const t = useT();
  return (
    <div className="row">
      <button className="btn" disabled={busy}>
        {busy ? t('admin.knowledge.adding') : t('admin.knowledge.add')}
      </button>
      <button type="button" className="btn secondary" onClick={onCancel}>
        {t('common.cancel')}
      </button>
    </div>
  );
}
