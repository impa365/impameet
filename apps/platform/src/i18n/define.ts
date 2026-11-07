import type { Locale } from './config';
import type { Messages, Shape } from './format';

export interface Namespace<T> {
  /** Portuguese, kept with its literal type so keys can be checked at compile time. */
  reference: T;
  byLocale: Record<Locale, Messages>;
}

/**
 * One namespace of messages. Portuguese is the reference: English and Spanish must have
 * exactly the same keys (the compiler refuses a missing or extra one).
 */
export function defineMessages<const T extends Messages>(
  pt: T,
  others: { en: Shape<T>; es: Shape<T> },
): Namespace<T> {
  return { reference: pt, byLocale: { 'pt-BR': pt, en: others.en as Messages, es: others.es as Messages } };
}
