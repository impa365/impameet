'use client';

import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { useT } from '@/i18n/client';
import { Icon } from '../../ui/Icon';
import { api } from '../../api';
import type { Integration } from '../IntegrationsTab';
import { messageOf } from '../useLoad';
import { HitList } from './SearchPanel';
import { type Base, type Hit, kbPath } from './types';

interface Turn {
  question: string;
  answer: string;
  hits: Hit[];
  ms: number;
}

/** "Chat de teste": an answer written only from this base, by the model picked here. */
export function ChatPanel({
  base,
  integrations,
  onOpen,
}: {
  base: Base;
  integrations: Integration[];
  onOpen: (sourceId: string) => void;
}) {
  const t = useT();
  const llms = integrations.filter((i) => i.kind === 'llm');
  const [integrationId, setIntegrationId] = useState('');
  const [model, setModel] = useState('');
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [shown, setShown] = useState<number | null>(null);
  const models = llms.find((i) => i.id === integrationId)?.models ?? [];

  async function ask(e: FormEvent) {
    e.preventDefault();
    if (!question.trim()) return;
    setBusy(true);
    setError('');
    try {
      const res = await api<{ answer: string; hits: Hit[]; ms: number }>(`${kbPath(base.id)}/chat`, {
        body: { question, integrationId, model },
      });
      setTurns([...turns, { question, ...res }]);
      setShown(turns.length);
      setQuestion('');
    } catch (err) {
      setError(messageOf(err, t('knowledge.chat.couldNotChat')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="settings-section">
        <header className="section-head">
          <p>{t('knowledge.chat.intro')}</p>
        </header>
        <div className="fields">
          <label>
            {t('knowledge.chat.integration')}
            <select value={integrationId} onChange={(e) => (setIntegrationId(e.target.value), setModel(''))}>
              <option value="" disabled>
                {t('knowledge.chat.choose')}
              </option>
              {llms.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('knowledge.chat.model')}
            <select value={model} disabled={!integrationId} onChange={(e) => setModel(e.target.value)}>
              <option value="" disabled>
                {t('knowledge.chat.choose')}
              </option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
        </div>
        {llms.length === 0 && (
          <span className="field-help">
            {t('knowledge.chat.noLlm')}{' '}
            <Link href="/admin?tab=integrations">{t('knowledge.list.goIntegrations')}</Link>
          </span>
        )}
        {integrationId && models.length === 0 && (
          <span className="field-help">{t('knowledge.chat.noModels')}</span>
        )}
      </section>

      {turns.length > 0 && (
        <ol className="kb-chat" aria-live="polite">
          {turns.map((turn, i) => (
            <li key={i}>
              <div className="kb-bubble you">
                <span className="kb-who">{t('knowledge.chat.you')}</span>
                <p>{turn.question}</p>
              </div>
              <div className="kb-bubble bot">
                <span className="kb-who">
                  <Icon name="smart_toy" size={16} />
                  {t('knowledge.chat.answer')}
                </span>
                <p>{turn.answer}</p>
                <footer className="row">
                  <span className="muted">{t('knowledge.chat.ms', { ms: turn.ms })}</span>
                  {turn.hits.length > 0 && (
                    <button
                      type="button"
                      className="btn text small"
                      onClick={() => setShown(shown === i ? null : i)}
                    >
                      <Icon name="menu_book" size={16} />
                      {t('knowledge.chat.sources')} · {turn.hits.length}
                    </button>
                  )}
                </footer>
              </div>
              {shown === i && <HitList hits={turn.hits} onOpen={onOpen} />}
            </li>
          ))}
        </ol>
      )}

      <form className="form settings-section panel-form" onSubmit={ask} noValidate>
        <div className="row kb-ask">
          <input
            maxLength={1000}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={t('knowledge.chat.placeholder')}
            aria-label={t('knowledge.nav.chat')}
          />
          <button className="btn" disabled={busy || !integrationId || !model}>
            <Icon name="send" size={18} />
            {busy ? t('knowledge.chat.thinking') : t('knowledge.chat.ask')}
          </button>
        </div>
        <div className="error" role="alert">
          {error}
        </div>
        {turns.length > 0 && (
          <button type="button" className="btn text small" onClick={() => (setTurns([]), setShown(null))}>
            {t('knowledge.chat.clear')}
          </button>
        )}
      </form>
    </>
  );
}
