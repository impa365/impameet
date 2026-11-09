'use client';

import { type FormEvent, useState } from 'react';
import { serverMessage, type T, useT } from '@/i18n/client';
import {
  FISH_TTS_MODELS,
  LLM_PRESETS,
  type LlmPreset,
  SPEECH_CATALOG,
  type SpeechProvider,
  presetFor,
} from '@/lib/providers';
import { api } from '../api';
import { messageOf, useLoad } from './useLoad';

export type IntegrationKind = 'llm' | 'embedding' | SpeechProvider;

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
  usedBy: number;
}

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
const newSpeech = (kind: SpeechProvider): Draft => ({
  ...NEW_LLM,
  kind,
  preset: '',
  baseUrl: '',
  defaultModel: kind === 'fish' ? 's2.1-pro' : '',
});

const KIND_LABEL = {
  llm: 'admin.integrations.kindLlm',
  embedding: 'admin.integrations.kindEmbedding',
  fish: 'admin.integrations.kindFish',
  deepgram: 'admin.integrations.kindDeepgram',
  elevenlabs: 'admin.integrations.kindElevenlabs',
} as const;

const presetName = (p: LlmPreset, t: T) => p.name || t('admin.integrations.customProvider');
const presetExample = (p: LlmPreset, t: T) => p.example || t('admin.integrations.customModelExample');

function Status({ i }: { i: Integration }) {
  const t = useT();
  if (i.lastTestOk === true) return <span className="pill ok">{t('admin.integrations.connected')}</span>;
  if (i.lastTestOk === false)
    return (
      <span className="pill bad" title={i.lastTestError ?? ''}>
        {t('admin.integrations.failed')}
      </span>
    );
  return <span className="pill">{t('admin.integrations.untested')}</span>;
}

export function IntegrationsTab() {
  const t = useT();
  const { data, error, setError, reload } = useLoad<{ enabled: boolean; integrations: Integration[] }>(
    '/api/admin/integrations',
  );
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(NEW_LLM);
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<{ id: string; models: string[] } | null>(null);
  const [notice, setNotice] = useState('');
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft({ ...draft, [k]: v });

  function edit(i: Integration | null, kind: Draft['kind'] = 'llm') {
    setError('');
    setNotice('');
    if (!i) {
      setEditing('new');
      setDraft(kind === 'llm' ? NEW_LLM : kind === 'embedding' ? NEW_EMBEDDING : newSpeech(kind));
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
        : draft.kind === 'embedding'
          ? {
              kind: 'embedding',
              name: draft.name,
              baseUrl: draft.baseUrl,
              apiKey: draft.apiKey || undefined,
              defaultModel: draft.defaultModel,
            }
          : draft.kind === 'fish'
            ? {
                kind: 'fish',
                name: draft.name,
                apiKey: draft.apiKey || undefined,
                defaultModel: draft.defaultModel,
              }
            : { kind: draft.kind, name: draft.name, apiKey: draft.apiKey || undefined };
    try {
      if (editing === 'new') await api('/api/admin/integrations', { body });
      else await api(`/api/admin/integrations/${editing}`, { method: 'PUT', body });
      setEditing(null);
      await reload();
    } catch (err) {
      setError(messageOf(err, t('admin.integrations.couldNotSave')));
    } finally {
      setBusy(false);
    }
  }

  async function test(i: Integration) {
    setNotice(t('admin.integrations.testing', { name: i.name }));
    try {
      const res = await api<{ ok: boolean; error?: string; models?: string[] }>(
        `/api/admin/integrations/${i.id}/test`,
        { body: {} },
      );
      setNotice(
        res.ok
          ? t('admin.integrations.testOk', { name: i.name })
          : `${i.name}: ${serverMessage(res.error ?? '')}`,
      );
      if (res.ok && i.kind === 'llm' && res.models?.length) setFound({ id: i.id, models: res.models });
      await reload();
    } catch (err) {
      setNotice('');
      setError(messageOf(err, t('admin.integrations.couldNotTest')));
    }
  }

  async function addModels(i: Integration, models: string[]) {
    try {
      await api(`/api/admin/integrations/${i.id}`, {
        method: 'PUT',
        body: {
          kind: 'llm',
          name: i.name,
          baseUrl: i.baseUrl,
          defaultModel: i.defaultModel,
          models: [...new Set([...i.models, ...models])],
        },
      });
      setFound(null);
      await reload();
    } catch (err) {
      setError(messageOf(err, t('admin.integrations.couldNotSaveModels')));
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
    return (
      <form onSubmit={save} className="card form" style={{ maxWidth: 720, margin: 0 }}>
        <strong>
          {editing === 'new' ? t('admin.integrations.newTitle') : t('admin.editNamed', { name: draft.name })}{' '}
          · {t(KIND_LABEL[draft.kind])}
        </strong>
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
                <span aria-hidden>{p.icon}</span> {presetName(p, t)}
              </button>
            ))}
          </div>
        )}
        <label>
          {t('admin.integrations.nameLabel')}
          <input required maxLength={60} value={draft.name} onChange={(e) => set('name', e.target.value)} />
        </label>
        {(draft.kind === 'llm' || draft.kind === 'embedding') && (
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
          <span className="muted">{t('admin.integrations.keyHint')}</span>
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
                {draft.models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </label>
            {draft.models.length > 0 && (
              <div className="chips" aria-label={t('admin.integrations.enabledModels')}>
                {draft.models.map((m) => (
                  <span key={m} className="chip">
                    {m}
                    <button
                      type="button"
                      aria-label={t('admin.integrations.removeModel', { model: m })}
                      onClick={() =>
                        set(
                          'models',
                          draft.models.filter((x) => x !== m),
                        )
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <span className="muted">{t('admin.integrations.testHint')}</span>
          </>
        ) : draft.kind === 'embedding' ? (
          <label>
            {t('admin.integrations.embeddingModel')}
            <input
              required
              maxLength={120}
              placeholder="text-embedding-3-small"
              value={draft.defaultModel}
              onChange={(e) => set('defaultModel', e.target.value)}
            />
            <span className="muted">{t('admin.integrations.embeddingHint')}</span>
          </label>
        ) : draft.kind !== 'fish' ? null : (
          <label>
            {t('admin.integrations.defaultVoiceModel')}
            <select value={draft.defaultModel} onChange={(e) => set('defaultModel', e.target.value)}>
              {FISH_TTS_MODELS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
        )}
        <div className="row">
          <button className="btn" disabled={busy}>
            {t('admin.integrations.saveIntegration')}
          </button>
          <button type="button" className="btn secondary" onClick={() => setEditing(null)}>
            {t('common.cancel')}
          </button>
        </div>
        <div className="error" role="alert">
          {error}
        </div>
      </form>
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
    { kind: 'fish', title: 'Fish Audio', hint: t('admin.integrations.fishHint') },
    { kind: 'deepgram', title: 'Deepgram', hint: t('admin.integrations.deepgramHint') },
    { kind: 'elevenlabs', title: 'ElevenLabs', hint: t('admin.integrations.elevenlabsHint') },
  ];

  return (
    <>
      <p className="muted" style={{ marginTop: 0 }}>
        {t('admin.integrations.intro')}
      </p>
      <div className="error" role="alert">
        {error}
      </div>
      {notice && <p role="status">{notice}</p>}
      {groups.map((g) => {
        const items = data?.integrations.filter((i) => i.kind === g.kind) ?? [];
        return (
          <section key={g.kind} style={{ marginBottom: 28 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <h3 style={{ margin: 0 }}>{g.title}</h3>
                <span className="muted">{g.hint}</span>
              </div>
              <button className="btn small" onClick={() => edit(null, g.kind)}>
                {t('common.add')}
              </button>
            </div>
            {items.length === 0 && (
              <p className="muted">{data ? t('admin.integrations.empty') : t('common.loading')}</p>
            )}
            <div className="card-grid">
              {items.map((i) => {
                const preset = i.kind === 'llm' ? presetFor(i.baseUrl) : null;
                return (
                  <article key={i.id} className="int-card">
                    <header>
                      <span className="int-icon" aria-hidden>
                        {preset
                          ? preset.icon
                          : i.kind === 'embedding'
                            ? '🧩'
                            : i.kind !== 'llm' && SPEECH_CATALOG[i.kind].icon}
                      </span>
                      <div>
                        <strong>{i.name}</strong>
                        <div className="muted">
                          {preset
                            ? presetName(preset, t)
                            : i.kind === 'embedding'
                              ? t('admin.integrations.kindEmbedding')
                              : i.kind !== 'llm' && SPEECH_CATALOG[i.kind].name}
                        </div>
                      </div>
                      <Status i={i} />
                    </header>
                    <dl>
                      {i.baseUrl && (
                        <>
                          <dt>{t('admin.integrations.url')}</dt>
                          <dd>{new URL(i.baseUrl).host}</dd>
                        </>
                      )}
                      <dt>{t('admin.integrations.key')}</dt>
                      <dd>{i.secretHint}</dd>
                      {i.defaultModel && (
                        <>
                          <dt>{t('admin.integrations.defaultModel')}</dt>
                          <dd>{i.defaultModel}</dd>
                        </>
                      )}
                      {i.kind === 'llm' && (
                        <>
                          <dt>{t('admin.integrations.models')}</dt>
                          <dd>{i.models.length}</dd>
                        </>
                      )}
                      <dt>{t('admin.integrations.agents')}</dt>
                      <dd>{i.usedBy}</dd>
                    </dl>
                    {found?.id === i.id && (
                      <div className="found">
                        <span className="muted">
                          {t('admin.integrations.foundModels', { n: found.models.length })}
                        </span>
                        <div className="chips">
                          {found.models
                            .filter((m) => !i.models.includes(m))
                            .slice(0, 60)
                            .map((m) => (
                              <button
                                key={m}
                                type="button"
                                className="chip add"
                                onClick={() => addModels(i, [m])}
                              >
                                + {m}
                              </button>
                            ))}
                        </div>
                      </div>
                    )}
                    <footer className="row">
                      <button className="btn secondary small" onClick={() => test(i)}>
                        {t('admin.integrations.testConnection')}
                      </button>
                      <button className="btn secondary small" onClick={() => edit(i)}>
                        {t('common.edit')}
                      </button>
                      <button className="btn danger small" onClick={() => remove(i)}>
                        {t('common.delete')}
                      </button>
                    </footer>
                  </article>
                );
              })}
            </div>
          </section>
        );
      })}
    </>
  );
}
