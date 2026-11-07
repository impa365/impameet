import type { Locale } from '../config';
import type { Messages } from '../format';
import admin from './admin';
import common from './common';
import dashboard from './dashboard';
import room from './room';
import shell from './shell';

const NAMESPACES = { common, shell, room, dashboard, admin };

/** The Portuguese tree: the reference every translation is checked against. */
export type AppMessages = { [N in keyof typeof NAMESPACES]: (typeof NAMESPACES)[N]['reference'] };

const cache = new Map<Locale, Messages>();

/** Server-only: the whole tree for one language (the browser receives only that one). */
export function messagesFor(locale: Locale): Messages {
  let messages = cache.get(locale);
  if (!messages) {
    messages = Object.fromEntries(
      Object.entries(NAMESPACES).map(([name, ns]) => [name, ns.byLocale[locale]]),
    ) as Messages;
    cache.set(locale, messages);
  }
  return messages;
}
