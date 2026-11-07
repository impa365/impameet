import { describe, expect, it } from 'vitest';
import { fromAcceptLanguage, parseLocale } from '@/i18n/config';
import { translate } from '@/i18n/format';
import { messagesFor } from '@/i18n/messages';
import { SERVER_ERRORS } from '@/i18n/server-errors';

describe('choosing the language', () => {
  it('reads a cookie value or a language tag', () => {
    expect(parseLocale('en')).toBe('en');
    expect(parseLocale('PT-br')).toBe('pt-BR');
    expect(parseLocale('pt-PT')).toBe('pt-BR');
    expect(parseLocale('es-AR')).toBe('es');
    expect(parseLocale('fr')).toBeUndefined();
    expect(parseLocale(undefined)).toBeUndefined();
  });

  it('picks the best supported browser language', () => {
    expect(fromAcceptLanguage('fr-FR,fr;q=0.9,es;q=0.8,en;q=0.7')).toBe('es');
    expect(fromAcceptLanguage('en-US,en;q=0.9')).toBe('en');
    expect(fromAcceptLanguage('de;q=1, pt-BR;q=0.5')).toBe('pt-BR');
    expect(fromAcceptLanguage('de, fr')).toBeUndefined();
    expect(fromAcceptLanguage('en;q=0, es')).toBe('es');
  });
});

describe('translate', () => {
  const messages = { a: { hi: 'Olá, {name}', n_one: '{count} pessoa', n_other: '{count} pessoas' } };

  it('fills placeholders and picks plurals', () => {
    expect(translate(messages, 'a.hi', { name: 'Ana' })).toBe('Olá, Ana');
    expect(translate(messages, 'a.n', { count: 1 })).toBe('1 pessoa');
    expect(translate(messages, 'a.n', { count: 3 })).toBe('3 pessoas');
    expect(translate(messages, 'a.missing')).toBe('a.missing');
  });

  it('has every language with the same keys', () => {
    const keys = (m: object, prefix = ''): string[] =>
      Object.entries(m).flatMap(([k, v]) =>
        typeof v === 'string' ? [prefix + k] : keys(v, `${prefix}${k}.`),
      );
    const pt = keys(messagesFor('pt-BR')).sort();
    expect(keys(messagesFor('en')).sort()).toEqual(pt);
    expect(keys(messagesFor('es')).sort()).toEqual(pt);
  });
});

describe('server messages', () => {
  it('are translated for every language except Portuguese', () => {
    expect(SERVER_ERRORS['pt-BR']).toEqual({});
    expect(Object.keys(SERVER_ERRORS.en).sort()).toEqual(Object.keys(SERVER_ERRORS.es).sort());
    expect(SERVER_ERRORS.en['Sala não encontrada']).toBe('Room not found');
  });
});
