'use client';

import { type FormEvent, useState } from 'react';
import { useLocale, useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/keys';
import { SPEECH_CATALOG, type SpeechProvider, VOICE_LANGUAGES, type VoiceLanguage } from '@/lib/providers';
import { api } from '../api';
import type { Integration } from './IntegrationsTab';
import { messageOf, useLoad } from './useLoad';

interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  knowledge: string;
  greeting: string;
  voices: Partial<Record<VoiceLanguage, string>>;
  ttsModel: string | null;
  sttModel: string | null;
  llmModel: string | null;
  listenMode: 'everyone' | 'moderators' | 'members';
  respondMode: 'always' | 'when_named';
  mutePolicy: 'everyone' | 'moderators' | 'disabled';
  moderationTools: ModerationTool[];
  moderationRules: string;
  llmIntegrationId: string | null;
  ttsIntegrationId: string | null;
  sttIntegrationId: string | null;
  isDefault: boolean;
  ready: boolean;
}

/** The form: every provider, model and voice is chosen here; nothing has a preset value. */
interface Draft {
  name: string;
  description: string;
  instructions: string;
  knowledge: string;
  greeting: string;
  voices: Record<VoiceLanguage, string>;
  ttsModel: string;
  sttModel: string;
  llmModel: string;
  listenMode: Agent['listenMode'];
  respondMode: Agent['respondMode'];
  mutePolicy: Agent['mutePolicy'];
  moderationTools: ModerationTool[];
  moderationRules: string;
  llmIntegrationId: string;
  ttsIntegrationId: string;
  sttIntegrationId: string;
}

const KNOWLEDGE_MAX = 100000;
const RULES_MAX = 4000;

type ModerationTool = 'remove' | 'mute' | 'lobby';
const MODERATION = {
  remove: ['admin.agents.modRemove', 'admin.agents.modRemoveHelp'],
  mute: ['admin.agents.modMute', 'admin.agents.modMuteHelp'],
  lobby: ['admin.agents.modLobby', 'admin.agents.modLobbyHelp'],
} as const satisfies Record<ModerationTool, readonly [MessageKey, MessageKey]>;

const EMPTY: Draft = {
  name: '',
  description: '',
  instructions: '',
  knowledge: '',
  greeting: '',
  voices: { pt: '', en: '', es: '' },
  ttsModel: '',
  sttModel: '',
  llmModel: '',
  listenMode: 'everyone',
  respondMode: 'always',
  mutePolicy: 'everyone',
  moderationTools: [],
  moderationRules: '',
  llmIntegrationId: '',
  ttsIntegrationId: '',
  sttIntegrationId: '',
};

const VOICE_LABEL = {
  pt: 'admin.agents.voicePt',
  en: 'admin.agents.voiceEn',
  es: 'admin.agents.voiceEs',
} as const satisfies Record<VoiceLanguage, MessageKey>;
const LISTEN = {
  everyone: 'admin.agents.listen.everyone',
  moderators: 'admin.agents.listen.moderators',
  members: 'admin.agents.listen.members',
} as const satisfies Record<Agent['listenMode'], MessageKey>;
const RESPOND = {
  always: 'admin.agents.respond.always',
  when_named: 'admin.agents.respond.when_named',
} as const satisfies Record<Agent['respondMode'], MessageKey>;
const MUTE = {
  everyone: 'admin.agents.mute.everyone',
  moderators: 'admin.agents.mute.moderators',
  disabled: 'admin.agents.mute.disabled',
} as const satisfies Record<Agent['mutePolicy'], MessageKey>;
export function AgentsTab() {
  const t = useT();
  const locale = useLocale();
  const { data, error, setError, reload } = useLoad<{ agents: Agent[] }>('/api/admin/agents');
  const integrations =
    useLoad<{ integrations: Integration[] }>('/api/admin/integrations').data?.integrations ?? [];
  const llms = integrations.filter((i) => i.kind === 'llm');
  const speech = integrations.filter((i) => i.kind !== 'llm');
  const nameOf = (id: string | null) => integrations.find((i) => i.id === id)?.name;
  const speechKind = (id: string | null): SpeechProvider | undefined => {
    const kind = integrations.find((i) => i.id === id)?.kind;
    return kind && kind !== 'llm' ? kind : undefined;
  };
  const speechLabel = (i: Integration) =>
    i.kind === 'llm' ? i.name : `${SPEECH_CATALOG[i.kind].icon} ${i.name} · ${SPEECH_CATALOG[i.kind].name}`;
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);

  function edit(agent: Agent | null) {
    setEditing(agent?.id ?? 'new');
    if (!agent) {
      setDraft(EMPTY);
      return;
    }
    setDraft({
      name: agent.name,
      description: agent.description,
      instructions: agent.instructions,
      knowledge: agent.knowledge,
      greeting: agent.greeting,
      voices: { pt: agent.voices.pt ?? '', en: agent.voices.en ?? '', es: agent.voices.es ?? '' },
      ttsModel: agent.ttsModel ?? '',
      sttModel: agent.sttModel ?? '',
      llmModel: agent.llmModel ?? '',
      listenMode: agent.listenMode,
      respondMode: agent.respondMode,
      mutePolicy: agent.mutePolicy,
      moderationTools: agent.moderationTools ?? [],
      moderationRules: agent.moderationRules ?? '',
      llmIntegrationId: agent.llmIntegrationId ?? '',
      ttsIntegrationId: agent.ttsIntegrationId ?? '',
      sttIntegrationId: agent.sttIntegrationId ?? '',
    });
  }

  async function makeDefault(agent: Agent) {
    try {
      await api(`/api/admin/agents/${agent.id}/default`, { body: {} });
      await reload();
    } catch (err) {
      setError(messageOf(err, t('admin.agents.couldNotMakeDefault')));
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const voices = Object.fromEntries(
      VOICE_LANGUAGES.map((l) => [l, draft.voices[l].trim()]).filter(([, v]) => v),
    );
    if (Object.keys(voices).length === 0) {
      setError(t('admin.agents.voicesHint'));
      setBusy(false);
      return;
    }
    const body = { ...draft, voices, llmModel: draft.llmModel.trim() };
    try {
      if (editing === 'new') await api('/api/admin/agents', { body });
      else await api(`/api/admin/agents/${editing}`, { method: 'PUT', body });
      setEditing(null);
      await reload();
    } catch (err) {
      setError(messageOf(err, t('admin.agents.couldNotSave')));
    } finally {
      setBusy(false);
    }
  }

  async function remove(agent: Agent) {
    if (!window.confirm(t('admin.agents.confirmDelete', { name: agent.name }))) return;
    try {
      await api(`/api/admin/agents/${agent.id}`, { method: 'DELETE', body: {} });
      await reload();
    } catch (err) {
      setError(messageOf(err, t('admin.couldNotDelete')));
    }
  }

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft({ ...draft, [key]: value });
  const llmIntegration = llms.find((i) => i.id === draft.llmIntegrationId);
  const ttsKind = speechKind(draft.ttsIntegrationId);
  const sttKind = speechKind(draft.sttIntegrationId);
  const ttsModels = ttsKind ? SPEECH_CATALOG[ttsKind].ttsModels : [];
  const sttModels = sttKind ? SPEECH_CATALOG[sttKind].sttModels : [];
  /** Switching provider keeps the model only if the new provider offers it. */
  const chooseTts = (id: string) => {
    const kind = speechKind(id);
    const models: readonly string[] = kind ? SPEECH_CATALOG[kind].ttsModels : [];
    setDraft({
      ...draft,
      ttsIntegrationId: id,
      ttsModel: models.includes(draft.ttsModel) ? draft.ttsModel : '',
    });
  };
  const chooseStt = (id: string) => {
    const kind = speechKind(id);
    const models: readonly string[] = kind ? SPEECH_CATALOG[kind].sttModels : [];
    setDraft({
      ...draft,
      sttIntegrationId: id,
      sttModel: models.includes(draft.sttModel) ? draft.sttModel : '',
    });
  };

  if (editing) {
    return (
      <form onSubmit={save} className="card form" style={{ maxWidth: 820, margin: 0 }}>
        <strong>
          {editing === 'new' ? t('admin.agents.newTitle') : t('admin.editNamed', { name: draft.name })}
        </strong>
        <label>
          {t('admin.agents.nameLabel')}
          <input required maxLength={60} value={draft.name} onChange={(e) => set('name', e.target.value)} />
        </label>
        <label>
          {t('admin.agents.descriptionLabel')}
          <input
            maxLength={160}
            value={draft.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder={t('admin.agents.descriptionPlaceholder')}
          />
        </label>
        <label>
          {t('admin.agents.instructionsLabel')}
          <textarea
            required
            rows={7}
            maxLength={20000}
            value={draft.instructions}
            onChange={(e) => set('instructions', e.target.value)}
            placeholder={t('admin.agents.instructionsPlaceholder')}
          />
        </label>
        <label>
          {t('admin.agents.knowledgeLabel')}
          <textarea
            rows={12}
            maxLength={KNOWLEDGE_MAX}
            value={draft.knowledge}
            onChange={(e) => set('knowledge', e.target.value)}
            placeholder={t('admin.agents.knowledgePlaceholder')}
          />
          <span className="muted">
            {t('admin.agents.knowledgeCount', {
              length: draft.knowledge.length.toLocaleString(locale),
              max: KNOWLEDGE_MAX.toLocaleString(locale),
            })}
          </span>
        </label>
        <label>
          {t('admin.agents.greetingLabel')}
          <input maxLength={500} value={draft.greeting} onChange={(e) => set('greeting', e.target.value)} />
        </label>
        <div className="row">
          <label style={{ flex: 1 }}>
            {t('admin.agents.listenLabel')}
            <select
              value={draft.listenMode}
              onChange={(e) => set('listenMode', e.target.value as Draft['listenMode'])}
            >
              {Object.entries(LISTEN).map(([v, l]) => (
                <option key={v} value={v}>
                  {t(l)}
                </option>
              ))}
            </select>
          </label>
          <label style={{ flex: 1 }}>
            {t('admin.agents.respondLabel')}
            <select
              value={draft.respondMode}
              onChange={(e) => set('respondMode', e.target.value as Draft['respondMode'])}
            >
              {Object.entries(RESPOND).map(([v, l]) => (
                <option key={v} value={v}>
                  {t(l)}
                </option>
              ))}
            </select>
          </label>
          <label style={{ flex: 1 }}>
            {t('admin.agents.muteLabel')}
            <select
              value={draft.mutePolicy}
              onChange={(e) => set('mutePolicy', e.target.value as Draft['mutePolicy'])}
            >
              {Object.entries(MUTE).map(([v, l]) => (
                <option key={v} value={v}>
                  {t(l)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          {t('admin.agents.muteHint')}
        </p>
        <fieldset className="group">
          <legend>{t('admin.agents.moderationLegend')}</legend>
          <p className="muted small-print">{t('admin.agents.moderationHint')}</p>
          {(Object.keys(MODERATION) as ModerationTool[]).map((tool) => (
            <label key={tool} className="switch">
              <input
                type="checkbox"
                checked={draft.moderationTools.includes(tool)}
                onChange={(e) =>
                  set(
                    'moderationTools',
                    e.target.checked
                      ? [...draft.moderationTools, tool]
                      : draft.moderationTools.filter((x) => x !== tool),
                  )
                }
              />
              <span>
                {t(MODERATION[tool][0])}
                <small>{t(MODERATION[tool][1])}</small>
              </span>
            </label>
          ))}
          <label>
            {t('admin.agents.rulesLabel')}
            <textarea
              rows={5}
              maxLength={RULES_MAX}
              value={draft.moderationRules}
              disabled={draft.moderationTools.length === 0}
              onChange={(e) => set('moderationRules', e.target.value)}
              placeholder={t('admin.agents.rulesPlaceholder')}
            />
            <span className="muted">{t('admin.agents.rulesHelp')}</span>
          </label>
        </fieldset>
        <fieldset className="group">
          <legend>{t('admin.agents.brainLegend')}</legend>
          <div className="row">
            <label style={{ flex: 1 }}>
              {t('admin.agents.integration')}
              <select
                required
                value={draft.llmIntegrationId}
                onChange={(e) => setDraft({ ...draft, llmIntegrationId: e.target.value, llmModel: '' })}
              >
                <option value="" disabled>
                  {t('admin.agents.choose')}
                </option>
                {llms.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ flex: 1 }}>
              {t('admin.agents.model')}
              <input
                required
                list="agent-llm-models"
                value={draft.llmModel}
                onChange={(e) => set('llmModel', e.target.value)}
                placeholder={t('admin.agents.modelPlaceholder')}
              />
              <datalist id="agent-llm-models">
                {(llmIntegration?.models ?? []).map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </label>
          </div>
          {llms.length === 0 && <span className="muted">{t('admin.agents.noLlm')}</span>}
        </fieldset>
        <p className="muted" style={{ margin: 0 }}>
          {t('admin.agents.speechMixHint')}
        </p>
        <fieldset className="group">
          <legend>{t('admin.agents.voiceLegend')}</legend>
          <div className="row">
            <label style={{ flex: 1 }}>
              {t('admin.agents.integration')}
              <select required value={draft.ttsIntegrationId} onChange={(e) => chooseTts(e.target.value)}>
                <option value="" disabled>
                  {t('admin.agents.choose')}
                </option>
                {speech.map((i) => (
                  <option key={i.id} value={i.id}>
                    {speechLabel(i)}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ flex: 1 }}>
              {t('admin.agents.voiceModel')}
              <select
                required
                disabled={!ttsKind}
                value={draft.ttsModel}
                onChange={(e) => set('ttsModel', e.target.value)}
              >
                <option value="" disabled>
                  {t('admin.agents.choose')}
                </option>
                {ttsModels.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </label>
          </div>
          <fieldset className="group">
            <legend>{t('admin.agents.voicesLegend')}</legend>
            <p className="muted small-print">{t('admin.agents.voicesHint')}</p>
            {ttsKind === 'deepgram' && (
              <p className="muted small-print">{t('admin.agents.deepgramVoiceHint')}</p>
            )}
            <div className="row">
              {VOICE_LANGUAGES.map((lang) => (
                <label key={lang} style={{ flex: 1 }}>
                  {t(VOICE_LABEL[lang])}
                  <input
                    value={draft.voices[lang]}
                    maxLength={64}
                    pattern="[A-Za-z0-9_\-]{4,64}"
                    placeholder={
                      (ttsKind && SPEECH_CATALOG[ttsKind].voiceExample?.[lang]) ||
                      t('admin.agents.voicePlaceholder')
                    }
                    onChange={(e) => set('voices', { ...draft.voices, [lang]: e.target.value })}
                  />
                </label>
              ))}
            </div>
          </fieldset>
        </fieldset>
        <fieldset className="group">
          <legend>{t('admin.agents.listenLegend')}</legend>
          <div className="row">
            <label style={{ flex: 1 }}>
              {t('admin.agents.integration')}
              <select required value={draft.sttIntegrationId} onChange={(e) => chooseStt(e.target.value)}>
                <option value="" disabled>
                  {t('admin.agents.choose')}
                </option>
                {speech.map((i) => (
                  <option key={i.id} value={i.id}>
                    {speechLabel(i)}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ flex: 1 }}>
              {t('admin.agents.sttModel')}
              <select
                required
                disabled={!sttKind}
                value={draft.sttModel}
                onChange={(e) => set('sttModel', e.target.value)}
              >
                <option value="" disabled>
                  {t('admin.agents.choose')}
                </option>
                {sttModels.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </label>
          </div>
          {speech.length === 0 && <span className="muted">{t('admin.agents.noSpeech')}</span>}
        </fieldset>{' '}
        <div className="row">
          <button className="btn" disabled={busy}>
            {t('admin.agents.saveAgent')}
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

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
        <p className="muted" style={{ margin: 0 }}>
          {t('admin.agents.intro')}
        </p>
        <button className="btn" onClick={() => edit(null)}>
          {t('admin.agents.newAgent')}
        </button>
      </div>
      <div className="error" role="alert">
        {error}
      </div>
      {data?.agents.length === 0 && <p className="muted">{t('admin.agents.empty')}</p>}
      <ul className="rooms">
        {data?.agents.map((a) => (
          <li key={a.id}>
            <div>
              <strong>{a.name}</strong>
              {a.isDefault && <span className="badge primary">{t('admin.agents.defaultBadge')}</span>}
              {!a.ready && (
                <span className="badge warn" title={t('admin.agents.incompleteHint')}>
                  {t('admin.agents.incomplete')}
                </span>
              )}
              <span className="badge">
                🧠 {nameOf(a.llmIntegrationId) ?? t('admin.agents.notChosen')}
                {a.llmModel ? ` · ${a.llmModel}` : ''}
              </span>
              <span className="badge" title={t('admin.agents.voiceLegend')}>
                🗣️ {nameOf(a.ttsIntegrationId) ?? t('admin.agents.notChosen')} ·{' '}
                {a.ttsModel ?? t('admin.agents.notChosen')}
                {' · '}
                {VOICE_LANGUAGES.filter((l) => a.voices[l])
                  .map((l) => l.toUpperCase())
                  .join('/') || t('admin.agents.notChosen')}
              </span>
              <span className="badge" title={t('admin.agents.listenLegend')}>
                👂 {nameOf(a.sttIntegrationId) ?? t('admin.agents.notChosen')} ·{' '}
                {a.sttModel ?? t('admin.agents.notChosen')}
              </span>
              <span className="badge">
                {t('admin.agents.listensBadge', { mode: t(LISTEN[a.listenMode]).toLowerCase() })}
              </span>
              <span className="badge">
                {a.respondMode === 'when_named'
                  ? t('admin.agents.respondsWhenNamed')
                  : t('admin.agents.respondsAlways')}
              </span>
              <span className="badge">
                {t('admin.agents.muteBadge', { mode: t(MUTE[a.mutePolicy]).toLowerCase() })}
              </span>
              {(a.moderationTools ?? []).length > 0 && (
                <span className="badge">
                  🛡️{' '}
                  {(a.moderationTools ?? []).map((tool) => t(MODERATION[tool][0]).toLowerCase()).join(', ')}
                </span>
              )}
              {a.description && <div className="agent-about">{a.description}</div>}
              <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
                {a.instructions.slice(0, 140)}
                {a.instructions.length > 140 ? '…' : ''} ·{' '}
                {t('admin.agents.knowledgeSummary', { length: a.knowledge.length.toLocaleString(locale) })}
              </div>
            </div>
            <div className="row">
              <button className="btn secondary small" onClick={() => edit(a)}>
                {t('common.edit')}
              </button>
              {!a.isDefault && (
                <>
                  <button className="btn secondary small" onClick={() => makeDefault(a)}>
                    {t('admin.agents.makeDefault')}
                  </button>
                  <button className="btn danger small" onClick={() => remove(a)}>
                    {t('common.delete')}
                  </button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
