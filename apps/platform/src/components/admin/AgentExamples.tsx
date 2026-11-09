'use client';

import { type FormEvent, useState } from 'react';
import { useT } from '@/i18n/client';
import { api } from '../api';
import { messageOf, useLoad } from './useLoad';

interface Example {
  id: string;
  question: string;
  answer: string;
  enabled: boolean;
}

/** Approved answers the agent imitates: the closest thing to fine-tuning that works with any LLM. */
export function AgentExamples({ agentId }: { agentId: string }) {
  const t = useT();
  const path = `/api/admin/agents/${agentId}/examples`;
  const { data, error, setError, reload } = useLoad<{ examples: Example[] }>(path);
  const [draft, setDraft] = useState({ question: '', answer: '' });
  const [busy, setBusy] = useState(false);

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api(path, { body: draft });
      setDraft({ question: '', answer: '' });
      await reload();
    } catch (err) {
      setError(messageOf(err, t('admin.couldNotSave')));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(x: Example) {
    try {
      await api(`${path}/${x.id}`, {
        method: 'PUT',
        body: { question: x.question, answer: x.answer, enabled: !x.enabled },
      });
      await reload();
    } catch (err) {
      setError(messageOf(err, t('admin.couldNotSave')));
    }
  }

  async function remove(x: Example) {
    try {
      await api(`${path}/${x.id}`, { method: 'DELETE', body: {} });
      await reload();
    } catch (err) {
      setError(messageOf(err, t('admin.couldNotDelete')));
    }
  }

  return (
    <section
      className="card form"
      style={{ maxWidth: 820, margin: '16px 0 0' }}
      aria-labelledby="agent-examples"
    >
      <strong id="agent-examples">{t('admin.examples.legend')}</strong>
      <p className="muted small-print">{t('admin.examples.intro')}</p>
      <div className="error" role="alert">
        {error}
      </div>
      {data?.examples.length === 0 && <p className="muted">{t('admin.examples.empty')}</p>}
      <ul className="rooms">
        {data?.examples.map((x) => (
          <li key={x.id}>
            <div>
              <strong>{x.question}</strong>
              {!x.enabled && <span className="badge warn">{t('admin.examples.off')}</span>}
              <div className="muted" style={{ fontSize: 13, marginTop: 4, whiteSpace: 'pre-wrap' }}>
                {x.answer}
              </div>
            </div>
            <div className="row">
              <button type="button" className="btn secondary small" onClick={() => toggle(x)}>
                {x.enabled ? t('admin.examples.disable') : t('admin.examples.enable')}
              </button>
              <button type="button" className="btn danger small" onClick={() => remove(x)}>
                {t('common.delete')}
              </button>
            </div>
          </li>
        ))}
      </ul>
      <form className="form" onSubmit={add}>
        <label>
          {t('admin.examples.question')}
          <input
            required
            maxLength={1000}
            value={draft.question}
            onChange={(e) => setDraft({ ...draft, question: e.target.value })}
            placeholder={t('admin.examples.questionPlaceholder')}
          />
        </label>
        <label>
          {t('admin.examples.answer')}
          <textarea
            required
            rows={3}
            maxLength={2000}
            value={draft.answer}
            onChange={(e) => setDraft({ ...draft, answer: e.target.value })}
            placeholder={t('admin.examples.answerPlaceholder')}
          />
        </label>
        <button className="btn" disabled={busy}>
          {t('admin.examples.add')}
        </button>
      </form>
    </section>
  );
}
