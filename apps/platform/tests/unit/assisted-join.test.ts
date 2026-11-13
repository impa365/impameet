import { describe, expect, it } from 'vitest';
import { MAX_NAME_LENGTH, isJoinCommand, spokenName, wantsAssistance } from '@/lib/assisted-join';

describe('assisted entry', () => {
  it.each([
    ['meu nome é ana souza', 'Ana Souza'],
    ['Meu nome e João da Silva.', 'João da Silva'],
    ['eu sou o Pedro', 'Pedro'],
    ['me chamo maria das dores', 'Maria das Dores'],
    ['sou a Kely', 'Kely'],
    ['my name is John Smith', 'John Smith'],
    ["I'm alice", 'Alice'],
    ['me llamo Juan de la Cruz', 'Juan de la Cruz'],
    ['Thiago Andrade', 'Thiago Andrade'],
    ['  breno   müller!  ', 'Breno Müller'],
  ])('takes the name out of "%s"', (said, name) => {
    expect(spokenName(said)).toBe(name);
  });

  it('keeps names within the display name limit and never invents one', () => {
    expect(spokenName('a'.repeat(200))).toHaveLength(MAX_NAME_LENGTH);
    expect(spokenName('')).toBe('');
    expect(spokenName('meu nome é')).toBe('');
  });

  it('understands "let me in" in the three languages, and nothing else', () => {
    for (const said of ['entrar', 'Quero entrar na sala', 'participar', 'join', 'enter', 'quiero unirme'])
      expect(isJoinCommand(said)).toBe(true);
    for (const said of ['Ana Souza', 'esperar', 'cancelar', 'não']) expect(isJoinCommand(said)).toBe(false);
  });

  it('opens the assisted entry from the room link', () => {
    expect(wantsAssistance('?assist=1')).toBe(true);
    expect(wantsAssistance('?ajuda=sim')).toBe(true);
    expect(wantsAssistance('?ayuda=si')).toBe(true);
    expect(wantsAssistance('?assist=0')).toBe(false);
    expect(wantsAssistance('')).toBe(false);
  });
});
