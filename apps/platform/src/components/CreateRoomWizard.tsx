'use client';

import Link from 'next/link';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/keys';
import type { AgentChoice, RoomAccess } from './RoomSettings';
import { MAX_ROOM_AGENTS } from './RoomSettings';
import type { RoomSummary } from './RoomsPanel';
import { ApiError, api } from './api';
import { Icon, type IconName } from './ui/Icon';

type Step = 'name' | 'access' | 'agents' | 'review' | 'done';
const STEPS: Exclude<Step, 'done'>[] = ['name', 'access', 'agents', 'review'];

const STEP_LABEL: Record<Exclude<Step, 'done'>, MessageKey> = {
  name: 'dashboard.wizard.steps.name',
  access: 'dashboard.wizard.steps.access',
  agents: 'dashboard.wizard.steps.agents',
  review: 'dashboard.wizard.steps.review',
};

const ACCESS_CARDS: { id: RoomAccess; icon: IconName; title: MessageKey; text: MessageKey }[] = [
  {
    id: 'trusted',
    icon: 'apartment',
    title: 'dashboard.wizard.access.trusted',
    text: 'dashboard.wizard.access.trustedText',
  },
  {
    id: 'restricted',
    icon: 'lock',
    title: 'dashboard.wizard.access.restricted',
    text: 'dashboard.wizard.access.restrictedText',
  },
  {
    id: 'open',
    icon: 'public',
    title: 'dashboard.wizard.access.open',
    text: 'dashboard.wizard.access.openText',
  },
];

const SUGGESTIONS: MessageKey[] = [
  'dashboard.wizard.suggestions.team',
  'dashboard.wizard.suggestions.class',
  'dashboard.wizard.suggestions.support',
  'dashboard.wizard.suggestions.oneOnOne',
  'dashboard.wizard.suggestions.sales',
];

/** Same idea as the server's slug: a preview of the room's link while it is being named. */
function previewSlug(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * A short guided flow to create a room: name, who gets in, which assistants join, then a
 * review. It is a page of its own in the rooms view, not a modal.
 */
export function CreateRoomWizard(props: {
  agents: AgentChoice[];
  onCreated: (room: RoomSummary) => void;
  onClose: () => void;
}) {
  const t = useT();
  const heading = useRef<HTMLHeadingElement>(null);
  const [step, setStep] = useState<Step>('name');
  const [name, setName] = useState('');
  const [access, setAccess] = useState<RoomAccess>('trusted');
  const [allowGuests, setAllowGuests] = useState(true);
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState('');
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [studio, setStudio] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<RoomSummary | null>(null);
  const [copied, setCopied] = useState(false);
  const [origin, setOrigin] = useState('');

  useEffect(() => {
    setOrigin(window.location.host);
  }, []);

  useEffect(() => {
    if (step !== 'name') heading.current?.focus();
  }, [step]);

  const index = step === 'done' ? STEPS.length : STEPS.indexOf(step);
  const slug = previewSlug(name) || 'sala';
  const passwordOk = !usePassword || password.length >= 4;
  const canContinue = step === 'name' ? name.trim().length > 0 : step === 'access' ? passwordOk : true;

  function go(to: Step) {
    setError('');
    setStep(to);
  }

  function next(e?: FormEvent) {
    e?.preventDefault();
    if (!canContinue) return;
    if (step === 'review') {
      void create();
      return;
    }
    go(STEPS[index + 1]);
  }

  async function create() {
    setBusy(true);
    setError('');
    try {
      const { room } = await api<{ room: RoomSummary }>('/api/rooms', {
        body: {
          name: name.trim(),
          password: usePassword ? password : undefined,
          allowGuests,
          access,
          agentIds,
          studio,
        },
      });
      setCreated(room);
      props.onCreated(room);
      setStep('done');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('dashboard.rooms.createFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    if (!created) return;
    await navigator.clipboard.writeText(`${window.location.origin}/r/${created.slug}`).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function toggleAgent(id: string) {
    setAgentIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }

  const chosenAgents = props.agents.filter((a) => agentIds.includes(a.id));
  const accessCard = ACCESS_CARDS.find((c) => c.id === access)!;

  return (
    <section className="wizard wizard-page" aria-labelledby="wizard-title">
      <form onSubmit={next} className="wizard-frame">
        <header className="wizard-top">
          {step !== 'done' ? (
            <ol className="wizard-steps" aria-label={t('dashboard.wizard.progress')}>
              {STEPS.map((s, i) => (
                <li
                  key={s}
                  className={i < index ? 'done' : i === index ? 'current' : ''}
                  aria-current={i === index ? 'step' : undefined}
                >
                  <span className="wizard-dot" aria-hidden>
                    {i < index ? <Icon name="check" size={16} /> : i + 1}
                  </span>
                  <span className="wizard-step-label">{t(STEP_LABEL[s])}</span>
                </li>
              ))}
            </ol>
          ) : (
            <span />
          )}
          <button type="button" className="icon-btn" aria-label={t('common.close')} onClick={props.onClose}>
            <Icon name="close" />
          </button>
        </header>

        <div className="wizard-body" key={step}>
          {step === 'name' && (
            <section className="wizard-step">
              <span className="wizard-badge" aria-hidden>
                <Icon name="video_call" size={32} />
              </span>
              <h2 id="wizard-title" ref={heading} tabIndex={-1}>
                {t('dashboard.wizard.name.title')}
              </h2>
              <p className="muted">{t('dashboard.wizard.name.text')}</p>
              <input
                className="wizard-input"
                autoFocus
                required
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('dashboard.wizard.name.placeholder')}
                aria-label={t('dashboard.rooms.nameLabel')}
              />
              <p className="wizard-link" aria-live="polite">
                <Icon name="link" size={18} />
                <span>
                  {origin}/r/<strong>{slug}</strong>
                </span>
              </p>
              <div className="choice-cards two" role="radiogroup" aria-label={t('studio.kind.title')}>
                {(
                  [
                    [false, 'video_call', 'studio.kind.meeting', 'studio.kind.meetingText'],
                    [true, 'live_tv', 'studio.kind.studio', 'studio.kind.studioText'],
                  ] as const
                ).map(([value, icon, title, text]) => (
                  <button
                    type="button"
                    key={title}
                    role="radio"
                    aria-checked={studio === value}
                    className={studio === value ? 'choice-card selected' : 'choice-card'}
                    onClick={() => setStudio(value)}
                  >
                    <span className="choice-icon" aria-hidden>
                      <Icon name={icon} />
                    </span>
                    <strong>{t(title)}</strong>
                    <small>{t(text)}</small>
                  </button>
                ))}
              </div>
              <div
                className="wizard-suggestions"
                role="group"
                aria-label={t('dashboard.wizard.name.suggestions')}
              >
                {SUGGESTIONS.map((key) => (
                  <button type="button" key={key} className="chip suggest" onClick={() => setName(t(key))}>
                    {t(key)}
                  </button>
                ))}
              </div>
            </section>
          )}

          {step === 'access' && (
            <section className="wizard-step">
              <h2 id="wizard-title" ref={heading} tabIndex={-1}>
                {t('dashboard.wizard.access.title')}
              </h2>
              <p className="muted">{t('dashboard.wizard.access.text')}</p>
              <div className="choice-cards" role="radiogroup" aria-label={t('dashboard.wizard.access.title')}>
                {ACCESS_CARDS.map((card) => (
                  <button
                    type="button"
                    key={card.id}
                    role="radio"
                    aria-checked={access === card.id}
                    className={access === card.id ? 'choice-card selected' : 'choice-card'}
                    onClick={() => setAccess(card.id)}
                  >
                    <span className="choice-icon" aria-hidden>
                      <Icon name={card.icon} />
                    </span>
                    <strong>
                      {t(card.title)}
                      {card.id === 'trusted' && (
                        <span className="tag">{t('dashboard.wizard.recommended')}</span>
                      )}
                    </strong>
                    <small>{t(card.text)}</small>
                  </button>
                ))}
              </div>
              <div className="wizard-options">
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={allowGuests}
                    onChange={(e) => setAllowGuests(e.target.checked)}
                  />
                  <span>
                    {t('dashboard.rooms.allowGuests')}
                    <small>{t('dashboard.wizard.access.guestsHint')}</small>
                  </span>
                </label>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={usePassword}
                    onChange={(e) => setUsePassword(e.target.checked)}
                  />
                  <span>
                    {t('dashboard.wizard.access.password')}
                    <small>{t('dashboard.wizard.access.passwordHint')}</small>
                  </span>
                </label>
                {usePassword && (
                  <input
                    type="password"
                    autoFocus
                    minLength={4}
                    maxLength={128}
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t('dashboard.wizard.access.passwordPlaceholder')}
                    aria-label={t('dashboard.rooms.passwordLabel')}
                  />
                )}
              </div>
            </section>
          )}

          {step === 'agents' && (
            <section className="wizard-step">
              <span className="wizard-badge ai" aria-hidden>
                <Icon name="auto_awesome" size={30} />
              </span>
              <h2 id="wizard-title" ref={heading} tabIndex={-1}>
                {t('dashboard.wizard.agents.title')}
              </h2>
              <p className="muted">{t('dashboard.wizard.agents.text', { max: MAX_ROOM_AGENTS })}</p>
              {props.agents.length === 0 ? (
                <p className="wizard-note">{t('dashboard.wizard.agents.none')}</p>
              ) : (
                <div className="agent-cards">
                  {props.agents.map((a) => {
                    const on = agentIds.includes(a.id);
                    const blocked = !a.ready || (!on && agentIds.length >= MAX_ROOM_AGENTS);
                    return (
                      <button
                        type="button"
                        key={a.id}
                        role="checkbox"
                        aria-checked={on}
                        aria-disabled={blocked || undefined}
                        className={on ? 'agent-card selected' : 'agent-card'}
                        onClick={() => {
                          if (!blocked || on) toggleAgent(a.id);
                        }}
                      >
                        <span className="agent-avatar" aria-hidden>
                          <Icon name="smart_toy" />
                        </span>
                        <span className="agent-card-text">
                          <strong>{a.name}</strong>
                          <small>
                            {a.ready
                              ? a.description || t('dashboard.wizard.agents.noDescription')
                              : t('dashboard.roomSettings.agentIncomplete')}
                          </small>
                        </span>
                        <span className="agent-card-check" aria-hidden>
                          {on && <Icon name="check" size={18} />}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              <p className="muted small-print">{t('dashboard.wizard.agents.later')}</p>
            </section>
          )}

          {step === 'review' && (
            <section className="wizard-step">
              <h2 id="wizard-title" ref={heading} tabIndex={-1}>
                {t('dashboard.wizard.review.title')}
              </h2>
              <p className="muted">{t('dashboard.wizard.review.text')}</p>
              <dl className="review">
                <div>
                  <dt>{t('dashboard.wizard.steps.name')}</dt>
                  <dd>
                    <strong>{name.trim()}</strong>
                    <small>
                      {studio ? `${t('studio.kind.studio')} · ` : ''}
                      {origin}/r/{slug}
                    </small>
                  </dd>
                  <button type="button" className="btn text small" onClick={() => go('name')}>
                    {t('common.edit')}
                  </button>
                </div>
                <div>
                  <dt>{t('dashboard.wizard.steps.access')}</dt>
                  <dd>
                    <strong>{t(accessCard.title)}</strong>
                    <small>
                      {[
                        allowGuests
                          ? t('dashboard.wizard.review.guestsYes')
                          : t('dashboard.wizard.review.guestsNo'),
                        usePassword ? t('dashboard.wizard.review.withPassword') : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </small>
                  </dd>
                  <button type="button" className="btn text small" onClick={() => go('access')}>
                    {t('common.edit')}
                  </button>
                </div>
                <div>
                  <dt>{t('dashboard.wizard.steps.agents')}</dt>
                  <dd>
                    <strong>
                      {chosenAgents.length > 0
                        ? chosenAgents.map((a) => a.name).join(', ')
                        : t('dashboard.wizard.review.noAgents')}
                    </strong>
                  </dd>
                  <button type="button" className="btn text small" onClick={() => go('agents')}>
                    {t('common.edit')}
                  </button>
                </div>
              </dl>
            </section>
          )}

          {step === 'done' && created && (
            <section className="wizard-step done">
              <span className="wizard-badge success" aria-hidden>
                <Icon name="celebration" size={34} />
              </span>
              <h2 id="wizard-title" ref={heading} tabIndex={-1}>
                {t('dashboard.wizard.done.title')}
              </h2>
              <p className="muted">{t('dashboard.wizard.done.text', { name: created.name })}</p>
              <div className="share-box">
                <Icon name="link" size={20} />
                <span className="share-url">
                  {origin}/r/{created.slug}
                </span>
                <button type="button" className="btn tonal small" onClick={() => void copyLink()}>
                  <Icon name={copied ? 'check' : 'content_copy'} size={18} />
                  {copied ? t('common.copied') : t('dashboard.rooms.copyLink')}
                </button>
              </div>
            </section>
          )}
        </div>

        <div className="error wizard-error" role="alert">
          {error}
        </div>

        <footer className="wizard-actions">
          {step === 'done' && created ? (
            <>
              <button type="button" className="btn text" onClick={props.onClose}>
                {t('dashboard.wizard.done.later')}
              </button>
              <Link className="btn large" href={`/r/${created.slug}`}>
                <Icon name="video_call" size={22} />
                {t('dashboard.wizard.done.joinNow')}
              </Link>
            </>
          ) : (
            <>
              {index > 0 ? (
                <button
                  type="button"
                  className="btn text"
                  onClick={() => go(STEPS[index - 1])}
                  disabled={busy}
                >
                  <Icon name="arrow_back" size={18} />
                  {t('common.back')}
                </button>
              ) : (
                <span />
              )}
              <button className="btn large" disabled={!canContinue || busy}>
                {step === 'review'
                  ? busy
                    ? t('dashboard.wizard.creating')
                    : t('dashboard.rooms.create')
                  : step === 'agents' && agentIds.length === 0
                    ? t('dashboard.wizard.skip')
                    : t('dashboard.wizard.continue')}
                {step !== 'review' && <Icon name="arrow_forward" size={18} />}
              </button>
            </>
          )}
        </footer>
      </form>
    </section>
  );
}
