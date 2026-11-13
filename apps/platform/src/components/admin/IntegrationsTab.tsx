'use client';

import { type FormEvent, useEffect, useState } from 'react';
import { serverMessage, type T, useT } from '@/i18n/client';
import { embeddingsFirst, modelCategory } from '@/lib/models';
import { LLM_PRESETS, type LlmPreset, SPEECH_CATALOG, type SpeechProvider, presetFor } from '@/lib/providers';
import { Icon, type IconName } from '../ui/Icon';
import { api } from '../api';
import { ModelPicker } from './ModelPicker';
import { messageOf, useLoad } from './useLoad';

export type IntegrationKind = 'llm' | 'embedding' | 'rerank' | SpeechProvider;

export interface Integration {
  id: string;
  kind: IntegrationKind;
  name: string;
  baseUrl: string | null;
  defaultModel: string | null;
  models: string[];
  secretHint: string;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
  /** What the last "Testar conexão" proved this key can do. */
  capabilities: Capability[];
  usedBy: number;
  usedByBases: number;
}

export type Capability = 'chat' | 'embeddings' | 'rerank';
const CAPABILITY_LABEL = {
  chat: 'admin.integrations.capChat',
  embeddings: 'admin.integrations.capEmbeddings',
  rerank: 'admin.integrations.capRerank',
} as const;
const OPENAI_COMPATIBLE: readonly IntegrationKind[] = ['llm', 'embedding', 'rerank'];

interface Draft {
  kind: IntegrationKind;
  name: string;
  preset: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  models: string[];
}

const NEW_LLM: Draft = {
  kind: 'llm',
  name: '',
  preset: 'openai',
  baseUrl: LLM_PRESETS[0].baseUrl,
  apiKey: '',
  defaultModel: '',
  models: [],
};
const NEW_EMBEDDING: Draft = { ...NEW_LLM, kind: 'embedding', preset: '', baseUrl: '' };
const NEW_RERANK: Draft = { ...NEW_LLM, kind: 'rerank', preset: '', baseUrl: '' };

/** Rerank APIs sharing the /rerank request; picking one fills the address, never the model. */
const RERANK_PRESETS = [
  {
    id: 'cohere',
    name: 'Cohere',
    baseUrl: 'https://api.cohere.com/v2',
    models: ['rerank-v3.5', 'rerank-multilingual-v3.0'],
  },
  {
    id: 'jina',
    name: 'Jina',
    baseUrl: 'https://api.jina.ai/v1',
    models: ['jina-reranker-v2-base-multilingual', 'jina-reranker-m0'],
  },
  {
    id: 'voyage',
    name: 'Voyage',
    baseUrl: 'https://api.voyageai.com/v1',
    models: ['rerank-2.5', 'rerank-2.5-lite'],
  },
] as const;
const newSpeech = (kind: SpeechProvider): Draft => ({ ...NEW_LLM, kind, preset: '', baseUrl: '' });

const KIND_LABEL = {
  llm: 'admin.integrations.kindLlm',
  embedding: 'admin.integrations.kindEmbedding',
  rerank: 'admin.integrations.kindRerank',
  fish: 'admin.integrations.kindFish',
  deepgram: 'admin.integrations.kindDeepgram',
  elevenlabs: 'admin.integrations.kindElevenlabs',
} as const;

/** The live model list of the form, for the URL and key it was fetched with. */
type Catalog = { key: string } & (
  | { state: 'loading' }
  | { state: 'ok'; models: string[]; embeddings?: string[] }
  | { state: 'error'; error: unknown }
);

/**
 * Lists the models of the URL and key being typed (or of the saved key, when editing), a moment
 * after the admin stops typing, and again whenever they ask.
 */
function useModelCatalog(editing: string | null, draft: Draft) {
  const integrationId = editing && editing !== 'new' ? editing : undefined;
  const baseUrl = draft.baseUrl.trim();
  const apiKey = draft.apiKey.trim();
  const ready =
    (draft.kind === 'llm' || draft.kind === 'embedding') &&
    /^https:\/\/[^/\s]+/.test(baseUrl) &&
    (apiKey.length >= 8 || Boolean(integrationId));
  const key = ready ? JSON.stringify([draft.kind, baseUrl, apiKey, integrationId]) : '';
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (!key) return;
    // JSON turns the missing id of a new integration into null: send no id at all then.
    const [kind, url, typedKey, id] = JSON.parse(key) as [string, string, string, string | null];
    let live = true;
    const timer = setTimeout(async () => {
      setCatalog({ key, state: 'loading' });
      try {
        const res = await api<{ ok: boolean; error?: string; models?: string[]; embeddings?: string[] }>(
          '/api/admin/integrations/models',
          { body: { kind, baseUrl: url, apiKey: typedKey || undefined, integrationId: id || undefined } },
        );
        if (!live) return;
        setCatalog(
          res.ok
            ? { key, state: 'ok', models: res.models ?? [], embeddings: res.embeddings }
            : { key, state: 'error', error: res.error ?? '' },
        );
      } catch (err) {
        if (live) setCatalog({ key, state: 'error', error: err });
      }
    }, 700);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, round]);

  return {
    ready,
    catalog: catalog?.key === key && key ? catalog : null,
    refresh: () => setRound((n) => n + 1),
  };
}

const presetName = (p: LlmPreset, t: T) => p.name || t('admin.integrations.customProvider');
const presetExample = (p: LlmPreset, t: T) => p.example || t('admin.integrations.customModelExample');

const KIND_ICON = {
  llm: 'psychology',
  embedding: 'menu_book',
  rerank: 'tune',
  fish: 'graphic_eq',
  deepgram: 'hearing',
  elevenlabs: 'record_voice_over',
} as const satisfies Record<IntegrationKind, IconName>;

function Status({ i }: { i: Integration }) {
  const t = useT();
  const [dot, label] =
    i.lastTestOk === true
      ? ['status-dot', t('admin.integrations.connected')]
      : i.lastTestOk === false
        ? ['status-dot bad', t('admin.integrations.failed')]
        : ['status-dot idle', t('admin.integrations.untested')];
  return (
    <span
      className="status-line int-status"
      title={i.lastTestOk === false ? (i.lastTestError ?? '') : undefined}
    >
      <span className={dot} aria-hidden />
      {label}
    </span>
  );
}

export function IntegrationsTab() {
  const t = useT();
  const { data, error, setError, reload } = useLoad<{ enabled: boolean; integrations: Integration[] }>(
    '/api/admin/integrations',
  );
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(NEW_LLM);
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [notice, setNotice] = useState('');
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft({ ...draft, [k]: v });
  const { ready, catalog, refresh } = useModelCatalog(editing, draft);
  const found = catalog?.state === 'ok' ? catalog.models : [];

  function edit(i: Integration | null, kind: Draft['kind'] = 'llm') {
    setError('');
    setNotice('');
    if (!i) {
      setEditing('new');
      setDraft(
        kind === 'llm'
          ? NEW_LLM
          : kind === 'embedding'
            ? NEW_EMBEDDING
            : kind === 'rerank'
              ? NEW_RERANK
              : newSpeech(kind),
      );
      return;
    }
    setEditing(i.id);
    setDraft({
      kind: i.kind,
      name: i.name,
      preset: presetFor(i.baseUrl).id,
      baseUrl: i.baseUrl ?? '',
      apiKey: '',
      defaultModel: i.defaultModel ?? '',
      models: i.models,
    });
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const body =
      draft.kind === 'llm'
        ? {
            kind: 'llm',
            name: draft.name,
            baseUrl: draft.baseUrl,
            apiKey: draft.apiKey || undefined,
            defaultModel: draft.defaultModel,
            models: draft.models,
          }
        : draft.kind === 'embedding' || draft.kind === 'rerank'
          ? {
              kind: draft.kind,
              name: draft.name,
              baseUrl: draft.baseUrl,
              apiKey: draft.apiKey || undefined,
              defaultModel: draft.defaultModel,
            }
          : { kind: draft.kind, name: draft.name, apiKey: draft.apiKey || undefined };
    try {
      const { integration } =
        editing === 'new'
          ? await api<{ integration: Integration }>('/api/admin/integrations', { body })
          : await api<{ integration: Integration }>(`/api/admin/integrations/${editing}`, {
              method: 'PUT',
              body,
            });
      setEditing(null);
      // A real call right away tells what the key can do (chat, embeddings, reranking).
      if (OPENAI_COMPATIBLE.includes(integration.kind)) await test(integration);
      else await reload();
    } catch (err) {
      setError(messageOf(err, t('admin.integrations.couldNotSave')));
    } finally {
      setBusy(false);
    }
  }

  async function test(i: Integration) {
    setNotice(t('admin.integrations.testing', { name: i.name }));
    try {
      const res = await api<{
        ok: boolean;
        error?: string;
        models?: string[];
        capabilities?: Capability[];
      }>(`/api/admin/integrations/${i.id}/test`, { body: {} });
      const serves = (res.capabilities ?? []).map((c) => t(CAPABILITY_LABEL[c])).join(', ');
      setNotice(
        !res.ok
          ? `${i.name}: ${serverMessage(res.error ?? '')}`
          : i.kind === 'llm' && res.models?.length
            ? `${t('admin.integrations.testOkModels', { name: i.name, n: res.models.length })} ${t('admin.integrations.serves', { list: serves })}`
            : t('admin.integrations.testOk', { name: i.name }),
      );
      await reload();
    } catch (err) {
      setNotice('');
      setError(messageOf(err, t('admin.integrations.couldNotTest')));
    }
  }

  async function remove(i: Integration) {
    const question = t('admin.integrations.confirmDelete', { name: i.name });
    const usage = i.usedBy ? ` ${t('admin.integrations.agentsFallBack', { count: i.usedBy })}` : '';
    if (!window.confirm(`${question}${usage}`)) return;
    try {
      await api(`/api/admin/integrations/${i.id}`, { method: 'DELETE', body: {} });
      await reload();
    } catch (err) {
      setError(messageOf(err, t('admin.couldNotDelete')));
    }
  }

  if (data && !data.enabled) {
    return <p className="muted">{t('admin.integrations.needsEncryptionKey')}</p>;
  }

  if (editing) {
    const preset = LLM_PRESETS.find((p) => p.id === draft.preset) ?? LLM_PRESETS[0];
    const embeddingModels =
      (catalog?.state === 'ok' ? catalog.embeddings : undefined) ??
      found.filter((m) => modelCategory(m) === 'embedding');
    const catalogLine = !ready
      ? t('admin.integrations.discoverHint')
      : !catalog || catalog.state === 'loading'
        ? t('admin.integrations.discovering')
        : catalog.state === 'error'
          ? t('admin.integrations.discoverFailed', {
              error:
                typeof catalog.error === 'string'
                  ? serverMessage(catalog.error)
                  : messageOf(catalog.error, t('admin.integrations.couldNotTest')),
            })
          : draft.kind === 'embedding' && catalog.models.length > 0
            ? embeddingModels.length > 0
              ? t('admin.integrations.discoveredEmbeddings', { n: embeddingModels.length })
              : t('admin.integrations.discoveredNoEmbeddings', { n: catalog.models.length })
            : catalog.models.length > 0
              ? t('admin.integrations.discovered', { n: catalog.models.length })
              : t('admin.integrations.discoveredNone');
    const catalogStatus = (
      <div className="row discover-status">
        <span className={catalog?.state === 'error' ? 'error' : 'muted'} role="status">
          {catalogLine}
        </span>
        {ready && catalog && catalog.state !== 'loading' && (
          <button type="button" className="btn secondary small" onClick={refresh}>
            {t('admin.integrations.refreshModels')}
          </button>
        )}
      </div>
    );
    const embeddingChoices = embeddingModels.slice(0, 40);
    const rerankModels: readonly string[] =
      RERANK_PRESETS.find((p) => p.baseUrl === draft.baseUrl)?.models ?? [];
    return (
      <div className="settings-body">
        <div className="settings-head">
          <button type="button" className="btn text small back-link" onClick={() => setEditing(null)}>
            <Icon name="arrow_back" size={18} />
            {t('admin.integrations.back')}
          </button>
          <h2>{editing === 'new' ? t('admin.integrations.newTitle') : draft.name}</h2>
          <span className="status-line">
            <Icon name={KIND_ICON[draft.kind]} size={18} />
            {t(KIND_LABEL[draft.kind])}
          </span>
        </div>
        <form onSubmit={save} className="form settings-form">
          <section className="settings-section">
            {draft.kind === 'llm' && (
              <div className="preset-grid" role="radiogroup" aria-label={t('admin.integrations.provider')}>
                {LLM_PRESETS.map((p) => (
                  <button
                    type="button"
                    key={p.id}
                    role="radio"
                    aria-checked={draft.preset === p.id}
                    className={draft.preset === p.id ? 'preset active' : 'preset'}
                    onClick={() => setDraft({ ...draft, preset: p.id, baseUrl: p.baseUrl || draft.baseUrl })}
                  >
                    {presetName(p, t)}
                  </button>
                ))}
              </div>
            )}
            <label>
              {t('admin.integrations.nameLabel')}
              <input
                required
                maxLength={60}
                value={draft.name}
                onChange={(e) => set('name', e.target.value)}
              />
            </label>
            {draft.kind === 'rerank' && (
              <div
                className="preset-grid"
                role="radiogroup"
                aria-label={t('admin.integrations.rerankProvider')}
              >
                {RERANK_PRESETS.map((p) => (
                  <button
                    type="button"
                    key={p.id}
                    role="radio"
                    aria-checked={draft.baseUrl === p.baseUrl}
                    className={draft.baseUrl === p.baseUrl ? 'preset active' : 'preset'}
                    onClick={() => setDraft({ ...draft, baseUrl: p.baseUrl, name: draft.name || p.name })}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            )}
            {(draft.kind === 'llm' || draft.kind === 'embedding' || draft.kind === 'rerank') && (
              <label>
                {t('admin.integrations.baseUrlLabel')}
                <input
                  required
                  type="url"
                  placeholder="https://…/v1"
                  value={draft.baseUrl}
                  onChange={(e) => set('baseUrl', e.target.value)}
                />
              </label>
            )}
            <label>
              {t('admin.integrations.apiKey')}
              <input
                type="password"
                autoComplete="off"
                required={editing === 'new'}
                placeholder={editing === 'new' ? '' : t('admin.integrations.keepKey')}
                value={draft.apiKey}
                onChange={(e) => set('apiKey', e.target.value)}
              />
              <span className="field-help">{t('admin.integrations.keyHint')}</span>
            </label>
            {draft.kind === 'llm' ? (
              <>
                <label>
                  {t('admin.integrations.defaultModel')}
                  <input
                    required
                    list="integration-models"
                    placeholder={presetExample(preset, t)}
                    value={draft.defaultModel}
                    onChange={(e) => set('defaultModel', e.target.value)}
                  />
                  <datalist id="integration-models">
                    {[...new Set([...found, ...draft.models])].map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                </label>
                {catalogStatus}
                <span className="field-help">{t('admin.integrations.llmReuseHint')}</span>
                {(found.length > 0 || draft.models.length > 0) && (
                  <ModelPicker
                    available={found}
                    embeddings={catalog?.state === 'ok' ? catalog.embeddings : undefined}
                    selected={draft.models}
                    principal={draft.defaultModel}
                    onSelected={(models) => set('models', models)}
                    onPrincipal={(m) =>
                      setDraft({
                        ...draft,
                        defaultModel: m,
                        models: draft.models.includes(m) ? draft.models : [...draft.models, m],
                      })
                    }
                  />
                )}
              </>
            ) : draft.kind === 'embedding' ? (
              <>
                <label>
                  {t('admin.integrations.embeddingModel')}
                  <input
                    required
                    maxLength={120}
                    list="embedding-models"
                    placeholder="text-embedding-3-small"
                    value={draft.defaultModel}
                    onChange={(e) => set('defaultModel', e.target.value)}
                  />
                  <datalist id="embedding-models">
                    {[...new Set([...embeddingModels, ...embeddingsFirst(found)])].map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                  <span className="field-help">{t('admin.integrations.embeddingHint')}</span>
                </label>
                {catalogStatus}
                {embeddingChoices.length > 0 && (
                  <div className="chips" role="group" aria-label={t('admin.integrations.embeddingPick')}>
                    {embeddingChoices.map((m) => (
                      <button
                        key={m}
                        type="button"
                        className={m === draft.defaultModel ? 'chip add accent' : 'chip add'}
                        aria-pressed={m === draft.defaultModel}
                        onClick={() => set('defaultModel', m)}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                )}
              </>
            ) : draft.kind === 'rerank' ? (
              <>
                <label>
                  {t('admin.integrations.rerankModel')}
                  <input
                    required
                    maxLength={120}
                    value={draft.defaultModel}
                    onChange={(e) => set('defaultModel', e.target.value)}
                  />
                  <span className="field-help">{t('admin.integrations.rerankModelHint')}</span>
                </label>
                {rerankModels.length > 0 && (
                  <div className="chips" role="group" aria-label={t('admin.integrations.rerankModel')}>
                    {rerankModels.map((m) => (
                      <button
                        key={m}
                        type="button"
                        className={m === draft.defaultModel ? 'chip add accent' : 'chip add'}
                        aria-pressed={m === draft.defaultModel}
                        onClick={() => set('defaultModel', m)}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                )}
              </>
            ) : null}
          </section>
          <div className="save-bar">
            <button className="btn" disabled={busy}>
              {t('admin.integrations.saveIntegration')}
            </button>
            <button type="button" className="btn secondary" onClick={() => setEditing(null)}>
              {t('common.cancel')}
            </button>
            <div className="error" role="alert">
              {error}
            </div>
          </div>
        </form>
      </div>
    );
  }

  const groups: { kind: Draft['kind']; title: string; hint: string }[] = [
    {
      kind: 'llm',
      title: t('admin.integrations.llmTitle'),
      hint: t('admin.integrations.llmHint'),
    },
    {
      kind: 'embedding',
      title: t('admin.integrations.embeddingTitle'),
      hint: t('admin.integrations.embeddingGroupHint'),
    },
    { kind: 'rerank', title: t('admin.integrations.rerankTitle'), hint: t('admin.integrations.rerankHint') },
    { kind: 'fish', title: 'Fish Audio', hint: t('admin.integrations.fishHint') },
    { kind: 'deepgram', title: 'Deepgram', hint: t('admin.integrations.deepgramHint') },
    { kind: 'elevenlabs', title: 'ElevenLabs', hint: t('admin.integrations.elevenlabsHint') },
  ];

  return (
    <>
      <div className="page-head">
        <p>{t('admin.integrations.intro')}</p>
        <button className="btn" aria-expanded={choosing} onClick={() => setChoosing(!choosing)}>
          <Icon name="add" size={18} />
          {t('admin.integrations.newIntegration')}
        </button>
      </div>
      {choosing && (
        <div className="kind-chooser" role="group" aria-label={t('admin.integrations.chooseKind')}>
          {groups.map((g) => (
            <button
              key={g.kind}
              type="button"
              className="kind-option"
              onClick={() => {
                setChoosing(false);
                edit(null, g.kind);
              }}
            >
              <span className="int-icon" aria-hidden>
                <Icon name={KIND_ICON[g.kind]} size={20} />
              </span>
              <span>
                <strong>{g.title}</strong>
                <small>{g.hint}</small>
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="error" role="alert">
        {error}
      </div>
      {notice && (
        <p role="status" className="status-line">
          {notice}
        </p>
      )}
      {groups.map((g) => {
        const items = data?.integrations.filter((i) => i.kind === g.kind) ?? [];
        return (
          <section key={g.kind} className="int-group" aria-labelledby={`int-group-${g.kind}`}>
            <div className="int-group-head">
              <div className="section-head">
                <h3 id={`int-group-${g.kind}`}>{g.title}</h3>
                <p>{g.hint}</p>
              </div>
              <button className="btn text small" onClick={() => edit(null, g.kind)}>
                <Icon name="add" size={18} />
                {t('common.add')}
              </button>
            </div>
            {items.length === 0 ? (
              <p className="int-empty">{data ? t('admin.integrations.empty') : t('common.loading')}</p>
            ) : (
              <ul className="card-list">
                {items.map((i) => {
                  const host = i.baseUrl ? new URL(i.baseUrl).host : '';
                  const preset = i.kind === 'llm' || i.kind === 'embedding' ? presetFor(i.baseUrl) : null;
                  const provider = preset
                    ? preset.id === 'custom'
                      ? host
                      : `${presetName(preset, t)} · ${host}`
                    : i.kind === 'rerank'
                      ? host
                      : i.kind !== 'llm' && i.kind !== 'embedding' && SPEECH_CATALOG[i.kind].name;
                  return (
                    <li key={i.id} className="tile">
                      <div className="tile-body">
                        <div className="tile-head">
                          <span className="tile-avatar" aria-hidden>
                            <Icon name={KIND_ICON[i.kind]} size={22} />
                          </span>
                          <div className="tile-title">
                            <strong>{i.name}</strong>
                            <span className="muted">{provider}</span>
                          </div>
                        </div>
                        <span className="tile-status">
                          <Status i={i} />
                        </span>
                        <dl className="tile-facts">
                          <div>
                            <dt>
                              <Icon name="key" size={16} />
                              {t('admin.integrations.key')}
                            </dt>
                            <dd>{i.secretHint}</dd>
                          </div>
                          <div>
                            <dt>
                              <Icon name="psychology" size={16} />
                              {t('admin.integrations.defaultModel')}
                            </dt>
                            <dd title={i.defaultModel ?? undefined}>
                              {i.defaultModel ?? <span className="unset">—</span>}
                            </dd>
                          </div>
                          {i.kind === 'llm' && (
                            <div>
                              <dt>
                                <Icon name="category" size={16} />
                                {t('admin.integrations.models')}
                              </dt>
                              <dd>{i.models.length}</dd>
                            </div>
                          )}
                          <div>
                            <dt>
                              <Icon name="smart_toy" size={16} />
                              {t('admin.integrations.agents')}
                            </dt>
                            <dd>{i.usedBy}</dd>
                          </div>
                          {i.usedByBases > 0 && (
                            <div>
                              <dt>
                                <Icon name="menu_book" size={16} />
                                {t('admin.integrations.bases')}
                              </dt>
                              <dd>{i.usedByBases}</dd>
                            </div>
                          )}
                        </dl>
                        {i.kind === 'llm' && i.capabilities.length > 0 && (
                          <p className="tile-text">
                            {t('admin.integrations.serves', {
                              list: i.capabilities.map((c) => t(CAPABILITY_LABEL[c])).join(', '),
                            })}
                          </p>
                        )}
                      </div>
                      <div className="tile-actions">
                        <button className="btn text small" onClick={() => test(i)}>
                          <Icon name="refresh" size={16} />
                          {t('admin.integrations.testConnection')}
                        </button>
                        <button className="btn text small" onClick={() => edit(i)}>
                          <Icon name="edit" size={16} />
                          {t('common.edit')}
                        </button>
                        <button
                          className="btn text danger small icon-only"
                          aria-label={t('admin.integrations.deleteNamed', { name: i.name })}
                          data-tip={t('common.delete')}
                          onClick={() => remove(i)}
                        >
                          <Icon name="delete" size={16} />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </>
  );
}
