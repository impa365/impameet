'use client';

import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { useLocale, useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/keys';
import { SPEECH_CATALOG, type SpeechProvider, VOICE_LANGUAGES, type VoiceLanguage } from '@/lib/providers';
import { Icon, type IconName } from '../ui/Icon';
import { api } from '../api';
import { AgentExamples } from './AgentExamples';
import { AgentTools } from './AgentTools';
import type { Integration } from './IntegrationsTab';
import { messageOf, useLoad } from './useLoad';
import { VoicePicker } from './VoicePicker';

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
  perception: Perception[];
  insights: Insight[];
  insightsAccess: 'moderators' | 'managers';
  minutesWebhook: string | null;
  knowledgeBaseIds: string[];
  styleRules: string;
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
  perception: Perception[];
  insights: Insight[];
  insightsAccess: 'moderators' | 'managers';
  minutesWebhook: string;
  knowledgeBaseIds: string[];
  styleRules: string;
  llmIntegrationId: string;
  ttsIntegrationId: string;
  sttIntegrationId: string;
}

const KNOWLEDGE_MAX = 100000;
const RULES_MAX = 4000;

type ModerationTool = 'remove' | 'mute' | 'camera' | 'lobby' | 'record';
const MODERATION = {
  remove: ['admin.agents.modRemove', 'admin.agents.modRemoveHelp'],
  mute: ['admin.agents.modMute', 'admin.agents.modMuteHelp'],
  camera: ['admin.agents.modCamera', 'admin.agents.modCameraHelp'],
  lobby: ['admin.agents.modLobby', 'admin.agents.modLobbyHelp'],
  record: ['admin.agents.modRecord', 'admin.agents.modRecordHelp'],
} as const satisfies Record<ModerationTool, readonly [MessageKey, MessageKey]>;

type Insight = 'minutes' | 'catchup' | 'copilot' | 'metrics';
const INSIGHTS = {
  minutes: ['admin.agents.insightMinutes', 'admin.agents.insightMinutesHelp'],
  catchup: ['admin.agents.insightCatchup', 'admin.agents.insightCatchupHelp'],
  copilot: ['admin.agents.insightCopilot', 'admin.agents.insightCopilotHelp'],
  metrics: ['admin.agents.insightMetrics', 'admin.agents.insightMetricsHelp'],
} as const satisfies Record<Insight, readonly [MessageKey, MessageKey]>;

type Perception = 'board' | 'polls' | 'screen';
const PERCEPTION = {
  board: ['admin.agents.seeBoard', 'admin.agents.seeBoardHelp'],
  polls: ['admin.agents.seePolls', 'admin.agents.seePollsHelp'],
  screen: ['admin.agents.seeScreen', 'admin.agents.seeScreenHelp'],
} as const satisfies Record<Perception, readonly [MessageKey, MessageKey]>;

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
  perception: [],
  insights: [],
  insightsAccess: 'moderators',
  minutesWebhook: '',
  knowledgeBaseIds: [],
  styleRules: '',
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
const AGENT_SECTIONS = [
  ['agent-identity', 'admin.agents.sectionIdentity', 'badge'],
  ['agent-brain', 'admin.agents.sectionBrainVoice', 'psychology'],
  ['agent-instructions', 'admin.agents.sectionInstructions', 'description'],
  ['agent-behavior', 'admin.agents.sectionBehavior', 'tune'],
  ['agent-moderation', 'admin.agents.moderationLegend', 'shield'],
  ['agent-insights', 'admin.agents.insightsLegend', 'summarize'],
  ['agent-perception', 'admin.agents.perceptionLegend', 'visibility'],
  ['agent-training', 'admin.agents.trainingLegend', 'school'],
  ['agent-examples-section', 'admin.agents.sectionExamples', 'chat'],
  ['agent-tools-section', 'admin.agents.sectionTools', 'extension'],
] as const satisfies readonly (readonly [string, MessageKey, IconName])[];
const SECTION_IDS = AGENT_SECTIONS.map(([id]) => id);

type Choices = Record<
  'llmIntegrationId' | 'llmModel' | 'ttsIntegrationId' | 'ttsModel' | 'sttIntegrationId' | 'sttModel',
  string | null
> & { voices: Partial<Record<VoiceLanguage, string>> };

/** What still has to be chosen before the agent can join meetings (nothing has a preset). */
function missingParts(c: Choices): MessageKey[] {
  const parts: (MessageKey | false)[] = [
    !c.llmIntegrationId && 'admin.agents.missingBrain',
    !!c.llmIntegrationId && !c.llmModel?.trim() && 'admin.agents.missingModel',
    !c.ttsIntegrationId && 'admin.agents.missingVoice',
    !!c.ttsIntegrationId && !c.ttsModel && 'admin.agents.missingVoiceModel',
    !VOICE_LANGUAGES.some((l) => c.voices[l]?.trim()) && 'admin.agents.missingVoiceId',
    !c.sttIntegrationId && 'admin.agents.missingEar',
    !!c.sttIntegrationId && !c.sttModel && 'admin.agents.missingEarModel',
  ];
  return parts.filter((p): p is MessageKey => p !== false);
}

function AgentStatus({ missing }: { missing: MessageKey[] }) {
  const t = useT();
  return (
    <span className="status-line" role="status">
      <span className={missing.length ? 'status-dot warn' : 'status-dot'} aria-hidden />
      {missing.length
        ? t('admin.agents.missing', { items: missing.map((m) => t(m)).join(', ') })
        : t('admin.agents.ready')}
    </span>
  );
}

function SectionHead({ id, title, hint }: { id: string; title: string; hint?: ReactNode }) {
  return (
    <header className="section-head">
      <h3 id={id}>{title}</h3>
      {hint && <p>{hint}</p>}
    </header>
  );
}

/** The section on screen, so the side navigation can show where the admin is. */
function useActiveSection(ids: readonly string[], on: boolean): string {
  const [active, setActive] = useState(ids[0]);
  useEffect(() => {
    if (!on) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      let current = ids[0];
      const line = Math.min(window.innerHeight * 0.35, 320);
      for (const id of ids) {
        const top = document.getElementById(id)?.getBoundingClientRect().top;
        if (top !== undefined && top <= line) current = id;
      }
      // At the very bottom the last sections never reach the top: they are the ones being read.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) {
        current = ids.filter((id) => document.getElementById(id)).at(-1) ?? current;
      }
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  }, [ids, on]);
  return active;
}

export function AgentsTab() {
  const t = useT();
  const locale = useLocale();
  const { data, error, setError, reload } = useLoad<{ agents: Agent[] }>('/api/admin/agents');
  const integrations =
    useLoad<{ integrations: Integration[] }>('/api/admin/integrations').data?.integrations ?? [];
  const bases = useLoad<{ bases: { id: string; name: string }[] }>('/api/admin/knowledge').data?.bases ?? [];
  const llms = integrations.filter((i) => i.kind === 'llm');
  const speech = integrations.filter((i) => i.kind !== 'llm' && i.kind !== 'embedding');
  const nameOf = (id: string | null) => integrations.find((i) => i.id === id)?.name;
  const speechKind = (id: string | null): SpeechProvider | undefined => {
    const kind = integrations.find((i) => i.id === id)?.kind;
    return kind && kind !== 'llm' && kind !== 'embedding' ? kind : undefined;
  };
  const speechLabel = (i: Integration) =>
    i.kind === 'llm' || i.kind === 'embedding' ? i.name : `${i.name} · ${SPEECH_CATALOG[i.kind].name}`;
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState<VoiceLanguage | null>(null);
  /** Names of the voices picked from the list, to show next to their ids. */
  const [voiceNames, setVoiceNames] = useState<Record<string, string>>({});
  const activeSection = useActiveSection(SECTION_IDS, editing !== null);

  function edit(agent: Agent | null) {
    setPicking(null);
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
      perception: agent.perception ?? [],
      insights: agent.insights ?? [],
      insightsAccess: agent.insightsAccess ?? 'moderators',
      minutesWebhook: agent.minutesWebhook ?? '',
      knowledgeBaseIds: agent.knowledgeBaseIds ?? [],
      styleRules: agent.styleRules ?? '',
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
    const isNew = editing === 'new';
    const missing = missingParts(draft);
    const switchList = <K extends string>(
      list: K[],
      key: 'moderationTools' | 'perception' | 'insights',
      labels: Record<K, readonly [MessageKey, MessageKey]>,
    ) =>
      (Object.keys(labels) as K[]).map((item) => (
        <label key={item} className="switch">
          <input
            type="checkbox"
            checked={list.includes(item)}
            onChange={(e) =>
              set(key, (e.target.checked ? [...list, item] : list.filter((x) => x !== item)) as never)
            }
          />
          <span>
            {t(labels[item][0])}
            <small>{t(labels[item][1])}</small>
          </span>
        </label>
      ));
    return (
      <div className="settings">
        <nav className="settings-nav" aria-label={t('admin.agents.sections')}>
          {AGENT_SECTIONS.filter(([id]) => !(isNew && id === 'agent-tools-section')).map(
            ([id, label, icon]) => (
              <a key={id} href={`#${id}`} aria-current={activeSection === id ? 'true' : undefined}>
                <Icon name={icon} size={18} />
                {t(label)}
              </a>
            ),
          )}
        </nav>
        <div className="settings-body">
          <div className="settings-head">
            <button type="button" className="btn text small back-link" onClick={() => setEditing(null)}>
              <Icon name="arrow_back" size={18} />
              {t('admin.agents.backToAgents')}
            </button>
            <h2>{isNew ? t('admin.agents.newTitle') : draft.name.trim() || t('admin.agents.newTitle')}</h2>
            <AgentStatus missing={missing} />
          </div>
          <form onSubmit={save} className="form settings-form">
            <section id="agent-identity" className="settings-section" aria-labelledby="agent-identity-h">
              <SectionHead id="agent-identity-h" title={t('admin.agents.sectionIdentity')} />
              <label>
                {t('admin.agents.nameLabel')}
                <input
                  required
                  maxLength={60}
                  value={draft.name}
                  onChange={(e) => set('name', e.target.value)}
                />
                <span className="field-help">{t('admin.agents.nameHelp')}</span>
              </label>
              <label>
                {t('admin.agents.descriptionLabel')}
                <input
                  maxLength={160}
                  value={draft.description}
                  onChange={(e) => set('description', e.target.value)}
                  placeholder={t('admin.agents.descriptionPlaceholder')}
                />
                <span className="field-help">{t('admin.agents.descriptionHelp')}</span>
              </label>
              <label>
                {t('admin.agents.greetingLabel')}
                <input
                  maxLength={500}
                  value={draft.greeting}
                  onChange={(e) => set('greeting', e.target.value)}
                />
                <span className="field-help">{t('admin.agents.greetingHelp')}</span>
              </label>
            </section>

            <section id="agent-brain" className="settings-section" aria-labelledby="agent-brain-h">
              <SectionHead
                id="agent-brain-h"
                title={t('admin.agents.sectionBrainVoice')}
                hint={t('admin.agents.speechMixHint')}
              />
              <h4>{t('admin.agents.brainLegend')}</h4>
              <div className="fields">
                <label>
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
                <label>
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
              {llms.length === 0 && <span className="field-help">{t('admin.agents.noLlm')}</span>}

              <h4>{t('admin.agents.voiceLegend')}</h4>
              <div className="fields">
                <label>
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
                <label>
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
              <span className="field-help">
                {t('admin.agents.voicesHint')}
                {ttsKind === 'deepgram' && <> {t('admin.agents.deepgramVoiceHint')}</>}
              </span>
              <div className="fields">
                {VOICE_LANGUAGES.map((lang) => (
                  <div key={lang} className="voice-field">
                    <label>
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
                    <div className="row voice-actions">
                      <button
                        type="button"
                        className="btn secondary small"
                        disabled={!ttsKind}
                        title={ttsKind ? undefined : t('admin.agents.pickVoiceFirst')}
                        aria-expanded={picking === lang}
                        onClick={() => setPicking(picking === lang ? null : lang)}
                      >
                        <Icon name="graphic_eq" size={18} />
                        {t('admin.agents.pickVoice')}
                      </button>
                      {voiceNames[draft.voices[lang]] && (
                        <span className="field-help">{voiceNames[draft.voices[lang]]}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              {picking && ttsKind && (
                <VoicePicker
                  key={`${draft.ttsIntegrationId}:${picking}`}
                  integrationId={draft.ttsIntegrationId}
                  kind={ttsKind}
                  family={draft.ttsModel}
                  language={picking}
                  languageName={t(VOICE_LABEL[picking])}
                  value={draft.voices[picking]}
                  onPick={(voice) => {
                    setDraft({ ...draft, voices: { ...draft.voices, [picking]: voice.id } });
                    setVoiceNames({ ...voiceNames, [voice.id]: voice.name });
                  }}
                  onClose={() => setPicking(null)}
                />
              )}

              <h4>{t('admin.agents.listenLegend')}</h4>
              <div className="fields">
                <label>
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
                <label>
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
              {speech.length === 0 && <span className="field-help">{t('admin.agents.noSpeech')}</span>}
            </section>

            <section
              id="agent-instructions"
              className="settings-section"
              aria-labelledby="agent-instructions-h"
            >
              <SectionHead id="agent-instructions-h" title={t('admin.agents.sectionInstructions')} />
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
                <span className="field-help">{t('admin.agents.instructionsHelp')}</span>
              </label>
              <label>
                {t('admin.agents.knowledgeLabel')}
                <textarea
                  rows={8}
                  maxLength={KNOWLEDGE_MAX}
                  value={draft.knowledge}
                  onChange={(e) => set('knowledge', e.target.value)}
                  placeholder={t('admin.agents.knowledgePlaceholder')}
                />
                <span className="field-help">
                  {t('admin.agents.knowledgeHelp')}{' '}
                  {t('admin.agents.knowledgeCount', {
                    length: draft.knowledge.length.toLocaleString(locale),
                    max: KNOWLEDGE_MAX.toLocaleString(locale),
                  })}
                </span>
              </label>
            </section>

            <section id="agent-behavior" className="settings-section" aria-labelledby="agent-behavior-h">
              <SectionHead id="agent-behavior-h" title={t('admin.agents.sectionBehavior')} />
              <div className="fields">
                <label>
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
                <label>
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
                <label>
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
              <span className="field-help">{t('admin.agents.muteHint')}</span>
            </section>

            <section id="agent-moderation" className="settings-section" aria-labelledby="agent-moderation-h">
              <SectionHead
                id="agent-moderation-h"
                title={t('admin.agents.moderationLegend')}
                hint={t('admin.agents.moderationHint')}
              />
              <div>{switchList(draft.moderationTools, 'moderationTools', MODERATION)}</div>
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
                <span className="field-help">{t('admin.agents.rulesHelp')}</span>
              </label>
            </section>

            <section id="agent-insights" className="settings-section" aria-labelledby="agent-insights-h">
              <SectionHead
                id="agent-insights-h"
                title={t('admin.agents.insightsLegend')}
                hint={t('admin.agents.insightsHint')}
              />
              <div>{switchList(draft.insights, 'insights', INSIGHTS)}</div>
              {(draft.insights.includes('copilot') || draft.insights.includes('metrics')) && (
                <fieldset className="plain">
                  <legend>{t('admin.agents.insightsAccessLegend')}</legend>
                  {(['moderators', 'managers'] as const).map((access) => (
                    <label key={access} className="radio-row">
                      <input
                        type="radio"
                        name="insights-access"
                        checked={draft.insightsAccess === access}
                        onChange={() => set('insightsAccess', access)}
                      />
                      <span>
                        {t(
                          access === 'moderators'
                            ? 'admin.agents.insightsAccessModerators'
                            : 'admin.agents.insightsAccessManagers',
                        )}
                      </span>
                    </label>
                  ))}
                </fieldset>
              )}
              {draft.insights.includes('minutes') && (
                <label>
                  {t('admin.agents.minutesWebhookLabel')}
                  <input
                    type="text"
                    inputMode="url"
                    maxLength={2000}
                    value={draft.minutesWebhook}
                    onChange={(e) => set('minutesWebhook', e.target.value)}
                    placeholder="https://n8n.suaempresa.com/webhook/ata"
                  />
                  <span className="field-help">{t('admin.agents.minutesWebhookHelp')}</span>
                </label>
              )}
            </section>

            <section id="agent-perception" className="settings-section" aria-labelledby="agent-perception-h">
              <SectionHead
                id="agent-perception-h"
                title={t('admin.agents.perceptionLegend')}
                hint={t('admin.agents.perceptionHint')}
              />
              <div>{switchList(draft.perception, 'perception', PERCEPTION)}</div>
            </section>

            <section id="agent-training" className="settings-section" aria-labelledby="agent-training-h">
              <SectionHead
                id="agent-training-h"
                title={t('admin.agents.trainingLegend')}
                hint={t('admin.agents.trainingHint')}
              />
              <label>
                {t('admin.agents.styleRulesLabel')}
                <textarea
                  rows={3}
                  maxLength={2000}
                  value={draft.styleRules}
                  onChange={(e) => set('styleRules', e.target.value)}
                  placeholder={t('admin.agents.styleRulesPlaceholder')}
                />
              </label>
              <h4>{t('admin.agents.knowledgeBasesLabel')}</h4>
              {bases.length === 0 && <span className="field-help">{t('admin.agents.noKnowledgeBases')}</span>}
              <div>
                {bases.map((b) => (
                  <label key={b.id} className="switch">
                    <input
                      type="checkbox"
                      checked={draft.knowledgeBaseIds.includes(b.id)}
                      onChange={(e) =>
                        set(
                          'knowledgeBaseIds',
                          e.target.checked
                            ? [...draft.knowledgeBaseIds, b.id]
                            : draft.knowledgeBaseIds.filter((x) => x !== b.id),
                        )
                      }
                    />
                    <span>{b.name}</span>
                  </label>
                ))}
              </div>
            </section>

            <div className="save-bar">
              <button className="btn" disabled={busy}>
                {t('admin.agents.saveAgent')}
              </button>
              <button type="button" className="btn secondary" onClick={() => setEditing(null)}>
                {t('common.cancel')}
              </button>
              <div className="error" role="alert">
                {error}
              </div>
            </div>
          </form>
          {isNew ? (
            <section id="agent-examples-section" className="settings-section">
              <span className="field-help">{t('admin.agents.saveFirstHint')}</span>
            </section>
          ) : (
            <>
              <span className="field-help">{t('admin.agents.afterSaveHint')}</span>
              <AgentExamples agentId={editing} />
              <AgentTools agentId={editing} />
            </>
          )}
        </div>
      </div>
    );
  }

  const unset = (value: string | null | undefined, text?: string | null) =>
    value ? (text ?? value) : <span className="unset">{t('admin.agents.notChosen')}</span>;

  return (
    <>
      <div className="page-head">
        <p>{t('admin.agents.intro')}</p>
        <button className="btn" onClick={() => edit(null)}>
          <Icon name="add" size={18} />
          {t('admin.agents.newAgent')}
        </button>
      </div>
      <div className="error" role="alert">
        {error}
      </div>
      {data?.agents.length === 0 && <p className="muted">{t('admin.agents.empty')}</p>}
      {(data?.agents.length ?? 0) > 0 && (
        <ul className="item-list">
          {data?.agents.map((a) => {
            const voices = VOICE_LANGUAGES.filter((l) => a.voices[l])
              .map((l) => l.toUpperCase())
              .join(' · ');
            return (
              <li key={a.id} className="agent-row">
                <div className="agent-row-name">
                  <strong>
                    {a.name}
                    {a.isDefault && <span className="pill">{t('admin.agents.defaultBadge')}</span>}
                  </strong>
                  {a.description && <span className="muted">{a.description}</span>}
                  <AgentStatus missing={a.ready ? [] : missingParts(a)} />
                </div>
                <div className="meta-cols">
                  <div className="meta">
                    <span>{t('admin.agents.brainColumn')}</span>
                    <span>
                      {unset(
                        a.llmIntegrationId,
                        [nameOf(a.llmIntegrationId), a.llmModel].filter(Boolean).join(' · '),
                      )}
                    </span>
                  </div>
                  <div className="meta">
                    <span>{t('admin.agents.voiceColumn')}</span>
                    <span>
                      {unset(
                        a.ttsIntegrationId,
                        [nameOf(a.ttsIntegrationId), a.ttsModel, voices].filter(Boolean).join(' · '),
                      )}
                    </span>
                  </div>
                  <div className="meta">
                    <span>{t('admin.agents.earColumn')}</span>
                    <span>
                      {unset(
                        a.sttIntegrationId,
                        [nameOf(a.sttIntegrationId), a.sttModel].filter(Boolean).join(' · '),
                      )}
                    </span>
                  </div>
                </div>
                <div className="row-actions">
                  {!a.isDefault && (
                    <>
                      <button className="btn text small" onClick={() => makeDefault(a)}>
                        {t('admin.agents.makeDefault')}
                      </button>
                      <button className="btn text danger small" onClick={() => remove(a)}>
                        {t('common.delete')}
                      </button>
                    </>
                  )}
                  <button className="btn secondary small" onClick={() => edit(a)}>
                    {t('common.edit')}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
