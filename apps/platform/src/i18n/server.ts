import 'server-only';
import { cookies, headers } from 'next/headers';
import { cache } from 'react';
import { currentTenant } from '@/server/request';
import { DEFAULT_LOCALE, LOCALE_COOKIE, type Locale, fromAcceptLanguage, parseLocale } from './config';
import { type Vars, translate } from './format';
import type { MessageKey } from './keys';
import { messagesFor } from './messages';
import { SERVER_ERRORS } from './server-errors';

/**
 * The reader's language: their own choice (cookie), else their browser's, else the
 * organization's default, else Portuguese.
 */
export const getLocale = cache(async (): Promise<Locale> => {
  const chosen = parseLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  if (chosen) return chosen;
  const browser = fromAcceptLanguage((await headers()).get('accept-language'));
  if (browser) return browser;
  const ctx = await currentTenant();
  return parseLocale(ctx?.branding.defaultLocale) ?? DEFAULT_LOCALE;
});

export async function getT() {
  const messages = messagesFor(await getLocale());
  return (key: MessageKey, vars?: Vars) => translate(messages, key, vars);
}

export function clientI18n(locale: Locale) {
  return { locale, messages: messagesFor(locale), serverErrors: SERVER_ERRORS[locale] };
}
