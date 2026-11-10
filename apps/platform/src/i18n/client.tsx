'use client';

import { createContext, type ReactNode, useCallback, useContext, useMemo } from 'react';
import type { Locale } from './config';
import { type Messages, type Vars, translate } from './format';
import type { MessageKey } from './keys';

interface I18n {
  locale: Locale;
  messages: Messages;
  serverErrors: Record<string, string>;
}

const I18nContext = createContext<I18n>({ locale: 'pt-BR', messages: {}, serverErrors: {} });

/** What the API client uses to show server messages in the reader's language. */
let currentServerErrors: Record<string, string> = {};
let currentLocale: Locale = 'pt-BR';

export function serverMessage(message: string): string {
  return known(message) ?? translateParts(message) ?? message;
}

const known = (message: string) => currentServerErrors[message] ?? translatePattern(message);

/** "Context: detail" messages (a page title, an upstream error) are translated part by part. */
function translateParts(message: string): string | undefined {
  const at = message.indexOf(': ');
  if (at < 0) return undefined;
  const head = message.slice(0, at);
  const tail = message.slice(at + 2);
  const headText = known(head);
  const tailText = known(tail);
  if (headText === undefined && tailText === undefined) return undefined;
  return `${headText ?? head}: ${tailText ?? tail}`;
}

export function activeLocale(): Locale {
  return currentLocale;
}

/** Server messages that carry a number ("até 4 assistentes") are matched with the number taken out. */
function translatePattern(message: string): string | undefined {
  const number = message.match(/\d+/)?.[0];
  if (!number) return undefined;
  const template = currentServerErrors[message.replace(number, '{n}')];
  return template?.replace('{n}', number);
}

export function I18nProvider(props: I18n & { children: ReactNode }) {
  const { locale, messages, serverErrors } = props;
  currentServerErrors = serverErrors;
  currentLocale = locale;
  const value = useMemo(() => ({ locale, messages, serverErrors }), [locale, messages, serverErrors]);
  return <I18nContext.Provider value={value}>{props.children}</I18nContext.Provider>;
}

export type T = (key: MessageKey, vars?: Vars) => string;

export function useT(): T {
  const { messages } = useContext(I18nContext);
  return useCallback((key: MessageKey, vars?: Vars) => translate(messages, key, vars), [messages]);
}

export function useLocale(): Locale {
  return useContext(I18nContext).locale;
}
