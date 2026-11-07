export const LOCALES = ['pt-BR', 'en', 'es'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'pt-BR';
export const LOCALE_COOKIE = 'impa_lang';

/** Each language written in itself, as people look for it in a menu. */
export const LOCALE_LABEL: Record<Locale, string> = {
  'pt-BR': 'Português (Brasil)',
  en: 'English',
  es: 'Español',
};

export function parseLocale(value: string | null | undefined): Locale | undefined {
  if (!value) return undefined;
  const exact = LOCALES.find((l) => l.toLowerCase() === value.toLowerCase());
  if (exact) return exact;
  const base = value.toLowerCase().split('-')[0];
  if (base === 'pt') return 'pt-BR';
  return LOCALES.find((l) => l === base);
}

/** The best supported language in an Accept-Language header, honouring q-values. */
export function fromAcceptLanguage(header: string | null | undefined): Locale | undefined {
  if (!header) return undefined;
  const ranked = header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.find((p) => p.trim().startsWith('q='));
      return { tag: tag.trim(), q: q ? Number(q.trim().slice(2)) || 0 : 1 };
    })
    .filter((x) => x.tag && x.q > 0)
    .sort((a, b) => b.q - a.q);
  for (const { tag } of ranked) {
    const locale = parseLocale(tag);
    if (locale) return locale;
  }
  return undefined;
}
