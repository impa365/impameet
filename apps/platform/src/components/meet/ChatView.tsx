'use client';

import { formatChatMessageLinks, useChat } from '@livekit/components-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useLocale, useT } from '@/i18n/client';
import { Icon } from '../ui/Icon';
import { displayName } from './MeetTile';

const time = (at: number, locale: string) =>
  new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });

/**
 * The in-call chat. It stays mounted while the panel is closed, because the chat only keeps
 * the messages that arrived while it was listening.
 */
export function ChatView({
  visible,
  onCount,
  onIncoming,
}: {
  visible: boolean;
  onCount: (count: number) => void;
  onIncoming: (from: string, text: string) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const { chatMessages, send, isSending } = useChat();
  const [text, setText] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const seen = useRef(0);
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    onCount(chatMessages.length);
    const tr = tRef.current;
    for (const m of chatMessages.slice(seen.current)) {
      if (!m.from?.isLocal) {
        onIncoming(m.from ? displayName(m.from, tr('room.aiAssistant')) : tr('room.participant'), m.message);
      }
    }
    seen.current = chatMessages.length;
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [chatMessages, onCount, onIncoming]);

  useEffect(() => {
    if (visible) list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [visible]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const message = text.trim();
    if (!message) return;
    await send(message).catch(() => undefined);
    setText('');
  }

  return (
    <div className="chat" hidden={!visible}>
      <p className="chat-note">{t('room.chat.note')}</p>
      <div className="chat-list" ref={list} role="log" aria-label={t('room.chat.log')}>
        {chatMessages.map((m, i) => {
          const prev = chatMessages[i - 1];
          const grouped =
            prev && prev.from?.identity === m.from?.identity && m.timestamp - prev.timestamp < 60_000;
          const who = m.from?.isLocal
            ? t('room.you')
            : m.from
              ? displayName(m.from, t('room.aiAssistant'))
              : t('room.participant');
          return (
            <div key={m.id ?? i} className={grouped ? 'chat-msg grouped' : 'chat-msg'}>
              {!grouped && (
                <div className="chat-meta">
                  <strong>{who}</strong> <span>{time(m.timestamp, locale)}</span>
                </div>
              )}
              <div className="chat-text">{formatChatMessageLinks(m.message)}</div>
            </div>
          );
        })}
      </div>
      <form className="chat-form" onSubmit={submit}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('room.chat.placeholder')}
          aria-label={t('room.chat.inputLabel')}
          maxLength={2000}
          disabled={isSending}
        />
        <button className="icon-btn" aria-label={t('room.chat.send')} disabled={isSending || !text.trim()}>
          <Icon name="send" size={22} />
        </button>
      </form>
    </div>
  );
}
