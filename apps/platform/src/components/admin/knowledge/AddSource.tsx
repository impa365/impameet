'use client';

import { type FormEvent, type ReactNode, useMemo, useRef, useState } from 'react';
import { serverMessage, useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/keys';
import { Icon } from '../../ui/Icon';
import { api } from '../../api';
import { messageOf } from '../useLoad';
import { type Base, KIND_ICON, KIND_LABEL, type SyncInterval, kbPath } from './types';

type AddKind = 'text' | 'file' | 'url' | 'website' | 'youtube' | 'qa';

const KINDS: [AddKind, MessageKey][] = [
  ['website', 'knowledge.kind.websiteHint'],
  ['file', 'knowledge.kind.fileHint'],
  ['youtube', 'knowledge.kind.youtubeHint'],
  ['url', 'knowledge.kind.urlHint'],
  ['text', 'knowledge.kind.textHint'],
  ['qa', 'knowledge.kind.qaHint'],
];

const ACCEPT = '.pdf,.docx,.xlsx,.pptx,.txt,.md,.markdown,.csv,.html,.htm,.json';
const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

function SyncSelect({ value, onChange }: { value: SyncInterval; onChange: (v: SyncInterval) => void }) {
  const t = useT();
  return (
    <label>
      {t('knowledge.add.sync')}
      <select value={value} onChange={(e) => onChange(e.target.value as SyncInterval)}>
        <option value="off">{t('knowledge.add.syncOff')}</option>
        <option value="daily">{t('knowledge.add.syncDaily')}</option>
        <option value="weekly">{t('knowledge.add.syncWeekly')}</option>
      </select>
      <span className="field-help">{t('knowledge.add.syncHelp')}</span>
    </label>
  );
}

function Buttons({ busy, label, onCancel }: { busy: boolean; label?: string; onCancel: () => void }) {
  const t = useT();
  return (
    <div className="row">
      <button className="btn" disabled={busy}>
        {busy ? t('knowledge.add.adding') : (label ?? t('knowledge.add.add'))}
      </button>
      <button type="button" className="btn secondary" onClick={onCancel}>
        {t('common.cancel')}
      </button>
    </div>
  );
}

function Panel({
  kind,
  children,
  onSubmit,
}: {
  kind: AddKind;
  children: ReactNode;
  onSubmit: (e: FormEvent) => void;
}) {
  const t = useT();
  return (
    <form className="form settings-section panel-form" onSubmit={onSubmit} noValidate>
      <header className="section-head kb-form-head">
        <span className="tile-avatar" aria-hidden>
          <Icon name={KIND_ICON[kind]} size={20} />
        </span>
        <h3>{t(KIND_LABEL[kind])}</h3>
      </header>
      {children}
    </form>
  );
}

/** Adding content: pick what kind, then one form for it. */
export function AddSource({ base, onAdded }: { base: Base; onAdded: () => void }) {
  const t = useT();
  const [kind, setKind] = useState<AddKind | null>(null);
  const [error, setError] = useState('');

  if (!kind)
    return (
      <section className="settings-section" aria-labelledby="kb-add-h">
        <header className="section-head">
          <h3 id="kb-add-h">{t('knowledge.add.chooseKind')}</h3>
        </header>
        <div className="kind-chooser">
          {KINDS.map(([k, hint]) => (
            <button key={k} type="button" className="kind-option" onClick={() => (setKind(k), setError(''))}>
              <span className="int-icon tile-avatar" aria-hidden>
                <Icon name={KIND_ICON[k]} size={20} />
              </span>
              <span>
                <strong>{t(KIND_LABEL[k])}</strong>
                <small>{t(hint)}</small>
              </span>
            </button>
          ))}
        </div>
      </section>
    );

  const props = { base, onDone: onAdded, onCancel: () => setKind(null), setError };
  return (
    <>
      <button type="button" className="btn text small back-link kb-back" onClick={() => setKind(null)}>
        <Icon name="arrow_back" size={18} />
        {t('knowledge.add.back')}
      </button>
      <div className="error" role="alert">
        {error}
      </div>
      {kind === 'text' && <TextForm {...props} />}
      {kind === 'file' && <FileForm {...props} />}
      {kind === 'url' && <UrlForm {...props} />}
      {kind === 'youtube' && <YouTubeForm {...props} />}
      {kind === 'qa' && <QaForm {...props} />}
      {kind === 'website' && <WebsiteForm {...props} />}
    </>
  );
}

interface FormProps {
  base: Base;
  onDone: () => void;
  onCancel: () => void;
  setError: (message: string) => void;
}

function useSend({ base, onDone, setError }: FormProps) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  async function send(body: unknown, path = 'sources') {
    setBusy(true);
    setError('');
    try {
      await api(`${kbPath(base.id)}/${path}`, { body });
      onDone();
    } catch (err) {
      setError(messageOf(err, t('knowledge.add.couldNotAdd')));
    } finally {
      setBusy(false);
    }
  }
  return { busy, send };
}

function TextForm(props: FormProps) {
  const t = useT();
  const { busy, send } = useSend(props);
  const [draft, setDraft] = useState({ title: '', content: '' });
  return (
    <Panel kind="text" onSubmit={(e) => (e.preventDefault(), void send({ kind: 'text', ...draft }))}>
      <label>
        {t('knowledge.add.title')}
        <input
          maxLength={200}
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        />
      </label>
      <label>
        {t('knowledge.add.content')}
        <textarea
          rows={14}
          value={draft.content}
          onChange={(e) => setDraft({ ...draft, content: e.target.value })}
          placeholder={t('knowledge.add.contentPlaceholder')}
        />
        <span className="field-help">{t('knowledge.add.contentHelp')}</span>
      </label>
      <Buttons busy={busy} onCancel={props.onCancel} />
    </Panel>
  );
}

function FileForm(props: FormProps) {
  const t = useT();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const size = (bytes: number) =>
    bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;

  async function upload(e: FormEvent) {
    e.preventDefault();
    if (!file) return input.current?.click();
    setBusy(true);
    props.setError('');
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`${kbPath(props.base.id)}/sources`, {
        method: 'POST',
        body: form,
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(serverMessage(body.error?.message ?? t('knowledge.add.couldNotAdd')));
      }
      props.onDone();
    } catch (err) {
      props.setError(err instanceof Error ? err.message : t('knowledge.add.couldNotAdd'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel kind="file" onSubmit={upload}>
      <label
        className={over ? 'kb-drop over' : 'kb-drop'}
        onDragOver={(e) => (e.preventDefault(), setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const dropped = e.dataTransfer.files[0];
          if (dropped) setFile(dropped);
        }}
      >
        <Icon name="upload_file" size={32} />
        <strong>
          {file
            ? t('knowledge.add.chosen', { name: file.name, size: size(file.size) })
            : t('knowledge.add.dropHere')}
        </strong>
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          className="sr-only"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </label>
      <span className="field-help">{t('knowledge.add.fileHelp')}</span>
      <Buttons busy={busy} onCancel={props.onCancel} />
    </Panel>
  );
}

function UrlForm(props: FormProps) {
  const t = useT();
  const { busy, send } = useSend(props);
  const [draft, setDraft] = useState({ url: '', title: '', syncInterval: 'off' as SyncInterval });
  return (
    <Panel kind="url" onSubmit={(e) => (e.preventDefault(), void send({ kind: 'url', ...draft }))}>
      <label>
        {t('knowledge.add.url')}
        <input
          type="url"
          inputMode="url"
          placeholder="https://suaempresa.com/precos"
          value={draft.url}
          onChange={(e) => setDraft({ ...draft, url: e.target.value })}
        />
        <span className="field-help">{t('knowledge.add.urlHelp')}</span>
      </label>
      <label>
        {t('knowledge.add.titleOptional')}
        <input
          maxLength={200}
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        />
      </label>
      <SyncSelect
        value={draft.syncInterval}
        onChange={(syncInterval) => setDraft({ ...draft, syncInterval })}
      />
      <Buttons busy={busy} onCancel={props.onCancel} />
    </Panel>
  );
}

function YouTubeForm(props: FormProps) {
  const t = useT();
  const { busy, send } = useSend(props);
  const [draft, setDraft] = useState({
    url: '',
    title: '',
    playlist: false,
    syncInterval: 'off' as SyncInterval,
  });
  const hasList = /[?&]list=/.test(draft.url);
  return (
    <Panel
      kind="youtube"
      onSubmit={(e) => (
        e.preventDefault(),
        void send({ kind: 'youtube', ...draft, playlist: hasList && draft.playlist })
      )}
    >
      <label>
        {t('knowledge.add.youtube')}
        <input
          type="url"
          inputMode="url"
          placeholder="https://www.youtube.com/watch?v=…"
          value={draft.url}
          onChange={(e) => setDraft({ ...draft, url: e.target.value })}
        />
        <span className="field-help">{t('knowledge.add.youtubeHelp')}</span>
      </label>
      {hasList && (
        <label className="switch">
          <input
            type="checkbox"
            checked={draft.playlist}
            onChange={(e) => setDraft({ ...draft, playlist: e.target.checked })}
          />
          <span>{t('knowledge.add.playlist')}</span>
        </label>
      )}
      {!(hasList && draft.playlist) && (
        <label>
          {t('knowledge.add.titleOptional')}
          <input
            maxLength={200}
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
        </label>
      )}
      <SyncSelect
        value={draft.syncInterval}
        onChange={(syncInterval) => setDraft({ ...draft, syncInterval })}
      />
      <Buttons busy={busy} onCancel={props.onCancel} />
    </Panel>
  );
}

export function PairsEditor({
  pairs,
  onChange,
  withActive,
}: {
  pairs: { id?: string; question: string; answer: string; active: boolean }[];
  onChange: (pairs: { id?: string; question: string; answer: string; active: boolean }[]) => void;
  withActive?: boolean;
}) {
  const t = useT();
  const set = (i: number, patch: Partial<(typeof pairs)[number]>) =>
    onChange(pairs.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <>
      {pairs.map((p, i) => (
        <fieldset className={p.active ? 'group kb-pair' : 'group kb-pair is-off'} key={p.id ?? i}>
          <legend>{t('knowledge.add.pairN', { n: i + 1 })}</legend>
          <div className="kb-pair-tools">
            {withActive && (
              <label className="switch">
                <input
                  type="checkbox"
                  checked={p.active}
                  onChange={(e) => set(i, { active: e.target.checked })}
                />
                <span>{t('knowledge.source.active')}</span>
              </label>
            )}
            {pairs.length > 1 && (
              <button
                type="button"
                className="btn text danger small icon-only"
                aria-label={t('knowledge.add.removePair')}
                data-tip={t('knowledge.add.removePair')}
                onClick={() => onChange(pairs.filter((_, j) => j !== i))}
              >
                <Icon name="delete" size={16} />
              </button>
            )}
          </div>
          <label>
            {t('knowledge.add.question')}
            <input
              maxLength={1000}
              value={p.question}
              onChange={(e) => set(i, { question: e.target.value })}
            />
          </label>
          <label>
            {t('knowledge.add.answer')}
            <textarea
              rows={3}
              maxLength={5000}
              value={p.answer}
              onChange={(e) => set(i, { answer: e.target.value })}
            />
          </label>
        </fieldset>
      ))}
      <button
        type="button"
        className="btn secondary small kb-add-pair"
        onClick={() => onChange([...pairs, { question: '', answer: '', active: true }])}
      >
        <Icon name="add" size={16} />
        {t('knowledge.add.addPair')}
      </button>
    </>
  );
}

function QaForm(props: FormProps) {
  const t = useT();
  const { busy, send } = useSend(props);
  const [title, setTitle] = useState('');
  const [pairs, setPairs] = useState([{ question: '', answer: '', active: true }]);
  return (
    <Panel
      kind="qa"
      onSubmit={(e) => (
        e.preventDefault(),
        void send({
          kind: 'qa',
          title,
          pairs: pairs
            .filter((p) => p.question.trim() || p.answer.trim())
            .map(({ question, answer }) => ({ question, answer })),
        })
      )}
    >
      <label>
        {t('knowledge.add.title')}
        <input maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="FAQ" />
      </label>
      <PairsEditor pairs={pairs} onChange={(p) => setPairs(p as typeof pairs)} />
      <Buttons busy={busy} onCancel={props.onCancel} />
    </Panel>
  );
}

interface FoundPage {
  url: string;
  title: string;
  via: 'start' | 'sitemap' | 'link';
}

const VIA: Record<FoundPage['via'], MessageKey> = {
  start: 'knowledge.add.viaStart',
  sitemap: 'knowledge.add.viaSitemap',
  link: 'knowledge.add.viaLink',
};

function WebsiteForm(props: FormProps) {
  const t = useT();
  const { busy, send } = useSend(props);
  const [draft, setDraft] = useState({ url: '', maxDepth: 2, include: '', exclude: '', respectRobots: true });
  const [syncInterval, setSyncInterval] = useState<SyncInterval>('off');
  const [finding, setFinding] = useState(false);
  const [pages, setPages] = useState<FoundPage[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const crawl = () => ({
    url: draft.url.trim(),
    maxDepth: draft.maxDepth,
    include: lines(draft.include),
    exclude: lines(draft.exclude),
    respectRobots: draft.respectRobots,
  });

  async function find(e: FormEvent) {
    e.preventDefault();
    setFinding(true);
    props.setError('');
    try {
      const res = await api<{ pages: FoundPage[] }>(`${kbPath(props.base.id)}/crawl`, { body: crawl() });
      setPages(res.pages);
      setChosen(new Set(res.pages.slice(0, 100).map((p) => p.url)));
    } catch (err) {
      props.setError(messageOf(err, t('knowledge.add.couldNotFind')));
    } finally {
      setFinding(false);
    }
  }

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (pages ?? []).filter(
      (p) => !q || p.url.toLowerCase().includes(q) || p.title.toLowerCase().includes(q),
    );
  }, [pages, query]);
  const toggle = (url: string, on: boolean) => {
    const next = new Set(chosen);
    if (on && next.size < 100) next.add(url);
    else next.delete(url);
    setChosen(next);
  };

  return (
    <>
      <Panel kind="website" onSubmit={find}>
        <label>
          {t('knowledge.add.siteUrl')}
          <input
            type="url"
            inputMode="url"
            placeholder="https://suaempresa.com"
            value={draft.url}
            onChange={(e) => (setDraft({ ...draft, url: e.target.value }), setPages(null))}
          />
        </label>
        <div className="fields">
          <label>
            {t('knowledge.add.depth')}
            <select
              value={draft.maxDepth}
              onChange={(e) => setDraft({ ...draft, maxDepth: Number(e.target.value) })}
            >
              {[0, 1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <span className="field-help">{t('knowledge.add.depthHelp')}</span>
          </label>
          <label className="switch kb-robots">
            <input
              type="checkbox"
              checked={draft.respectRobots}
              onChange={(e) => setDraft({ ...draft, respectRobots: e.target.checked })}
            />
            <span>{t('knowledge.add.robots')}</span>
          </label>
        </div>
        <div className="fields">
          <label>
            {t('knowledge.add.include')}
            <textarea
              rows={2}
              placeholder="/docs/*"
              value={draft.include}
              onChange={(e) => setDraft({ ...draft, include: e.target.value })}
            />
          </label>
          <label>
            {t('knowledge.add.exclude')}
            <textarea
              rows={2}
              placeholder="/blog/*"
              value={draft.exclude}
              onChange={(e) => setDraft({ ...draft, exclude: e.target.value })}
            />
          </label>
        </div>
        <span className="field-help">{t('knowledge.add.patternsHelp')}</span>
        <div className="row">
          <button className="btn" disabled={finding}>
            <Icon name="search" size={18} />
            {finding ? t('knowledge.add.finding') : t('knowledge.add.findPages')}
          </button>
          <button type="button" className="btn secondary" onClick={props.onCancel}>
            {t('common.cancel')}
          </button>
        </div>
      </Panel>
      {pages && (
        <form
          className="form settings-section panel-form"
          noValidate
          onSubmit={(e) => (
            e.preventDefault(),
            void send({ ...crawl(), pages: [...chosen], syncInterval }, 'website')
          )}
        >
          <header className="section-head">
            <h3>{t('knowledge.add.found', { count: pages.length })}</h3>
            <p>{t('knowledge.add.selected', { count: chosen.size, total: pages.length })}</p>
          </header>
          {pages.length === 0 ? (
            <p className="int-empty">{t('knowledge.add.noPages')}</p>
          ) : (
            <>
              <div className="row kb-page-tools">
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('knowledge.add.filterPages')}
                  aria-label={t('knowledge.add.filterPages')}
                />
                <button
                  type="button"
                  className="btn secondary small"
                  onClick={() => setChosen(new Set([...chosen, ...visible.map((p) => p.url)].slice(0, 100)))}
                >
                  {t('knowledge.add.selectAll')}
                </button>
                <button type="button" className="btn secondary small" onClick={() => setChosen(new Set())}>
                  {t('knowledge.add.selectNone')}
                </button>
              </div>
              <ul className="kb-pages">
                {visible.map((p) => (
                  <li key={p.url}>
                    <label>
                      <input
                        type="checkbox"
                        checked={chosen.has(p.url)}
                        onChange={(e) => toggle(p.url, e.target.checked)}
                      />
                      <span className="kb-page-text">
                        <strong>{p.title || new URL(p.url).pathname}</strong>
                        <span className="muted">{p.url}</span>
                      </span>
                      <span className="chip">{t(VIA[p.via])}</span>
                    </label>
                  </li>
                ))}
              </ul>
              <SyncSelect value={syncInterval} onChange={setSyncInterval} />
              <div className="row">
                <button className="btn" disabled={busy || chosen.size === 0}>
                  {busy ? t('knowledge.add.adding') : t('knowledge.add.importPages', { count: chosen.size })}
                </button>
              </div>
            </>
          )}
        </form>
      )}
    </>
  );
}
