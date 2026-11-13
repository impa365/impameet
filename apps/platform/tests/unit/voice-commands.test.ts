import { describe, expect, it } from 'vitest';
import { parseA11yPrefs } from '@/lib/a11y';
import {
  DEFAULT_WAKE_WORD,
  normalizeSpeech,
  parseDeviceAnswer,
  parseVoiceCommand,
  parseYesNo,
  wakeKey,
} from '@/lib/voice-commands';

describe('spoken yes or no', () => {
  it.each([
    'Sim',
    'sim, está correto',
    'isso mesmo',
    'pode confirmar',
    'Está certo.',
    'yes',
    "yeah that's right",
    'sí',
    'es correcto',
    'claro',
  ])('"%s" is a yes', (said) => expect(parseYesNo(said)).toBe('yes'));

  it.each([
    'Não',
    'nao',
    'está errado',
    'corrigir',
    'não está correto',
    'não é isso',
    'no',
    "that's not right",
    'wrong',
    'no es correcto',
    'incorrecto',
  ])('"%s" is a no', (said) => expect(parseYesNo(said)).toBe('no'));

  it.each(['repetir', 'repete por favor', 'de novo', 'say it again', 'otra vez'])(
    '"%s" asks to repeat',
    (said) => expect(parseYesNo(said)).toBe('repeat'),
  );

  it.each(['', 'talvez', 'sim não', 'banana', 'não sei, sim'])('"%s" is not clear', (said) =>
    expect(parseYesNo(said)).toBeNull(),
  );
});

describe('keeping or changing a device', () => {
  it.each([
    ['liga', false, true],
    ['pode ligar', false, true],
    ['quero ligado', false, true],
    ['manter ligado', false, true],
    ['turn it on', false, true],
    ['enciéndelo, enciende', false, true],
    ['desliga', true, false],
    ['manter desligado', true, false],
    ['pode desligar', true, false],
    ['mute', true, false],
    ['apaga', true, false],
    ['manter', true, true],
    ['manter', false, false],
    ['deixa assim', true, true],
    ['keep it', false, false],
    ['mantener', true, true],
  ] as const)('"%s" with the device %s → %s', (said, current, wanted) =>
    expect(parseDeviceAnswer(said, current)).toBe(wanted),
  );

  it.each(['liga e desliga', 'não liga', "don't turn it off", 'sim', 'banana', ''])(
    '"%s" changes nothing',
    (said) => {
      expect(parseDeviceAnswer(said, true)).toBeNull();
      expect(parseDeviceAnswer(said, false)).toBeNull();
    },
  );

  it('never reads "desligado" as "ligado"', () => {
    expect(parseDeviceAnswer('desligado', true)).toBe(false);
    expect(parseDeviceAnswer('ligado', false)).toBe(true);
  });
});

describe('the local assistant', () => {
  it('acts only when called by name', () => {
    expect(parseVoiceCommand('desliga meu microfone', 'Star')).toBeNull();
    expect(parseVoiceCommand('a star desliga meu microfone', 'Star')).toBeNull();
    expect(parseVoiceCommand('vou desligar a câmera, Star', 'Star')).toBeNull();
    expect(parseVoiceCommand('', 'Star')).toBeNull();
    expect(parseVoiceCommand('star desliga o microfone', '  ')).toBeNull();
  });

  it.each([
    ['Star, desliga meu microfone', { kind: 'set', devices: ['microphone'], on: false }],
    ['star liga meu microfone', { kind: 'set', devices: ['microphone'], on: true }],
    ['Estar, liga minha câmera', { kind: 'set', devices: ['camera'], on: true }],
    ['ok star turn off my camera', { kind: 'set', devices: ['camera'], on: false }],
    ['Star, desliga o microfone e a câmera', { kind: 'set', devices: ['microphone', 'camera'], on: false }],
    ['Star, apaga mi micrófono', { kind: 'set', devices: ['microphone'], on: false }],
    ['Star, qual é o estado do meu microfone?', { kind: 'status', devices: ['microphone'] }],
    ['Star, minha câmera está ligada?', { kind: 'status', devices: ['camera'] }],
    ['star is my microphone on', { kind: 'status', devices: ['microphone'] }],
    ['Star, entra na sala', { kind: 'join' }],
    ['Star, repete', { kind: 'repeat' }],
    ['Star, liga e desliga o microfone', { kind: 'unknown' }],
    ['Star, não desliga o microfone', { kind: 'unknown' }],
    ['Star, microfone', { kind: 'unknown' }],
    ['Star', { kind: 'unknown' }],
    ['Star, conta uma piada', { kind: 'unknown' }],
  ] as const)('"%s"', (said, expected) => expect(parseVoiceCommand(said, 'Star')).toEqual(expected));

  it('answers to the name the person chose', () => {
    expect(parseVoiceCommand('Luna, desliga a câmera', 'Luna')).toEqual({
      kind: 'set',
      devices: ['camera'],
      on: false,
    });
    expect(parseVoiceCommand('Star, desliga a câmera', 'Luna')).toBeNull();
    expect(parseVoiceCommand('Assistente Meet, liga o microfone', 'Assistente Meet')).toEqual({
      kind: 'set',
      devices: ['microphone'],
      on: true,
    });
  });

  it('keeps a usable name in the saved preferences', () => {
    expect(normalizeSpeech('  Olá, Câmera!  ')).toBe('ola camera');
    expect(wakeKey('!!!')).toBe('');
    expect(parseA11yPrefs(null)).toMatchObject({ voiceCommands: false, wakeWord: DEFAULT_WAKE_WORD });
    expect(parseA11yPrefs(JSON.stringify({ voiceCommands: true, wakeWord: 'Luna' }))).toMatchObject({
      voiceCommands: true,
      wakeWord: 'Luna',
    });
    expect(parseA11yPrefs(JSON.stringify({ wakeWord: '???' })).wakeWord).toBe(DEFAULT_WAKE_WORD);
    expect(parseA11yPrefs(JSON.stringify({ wakeWord: 7 })).wakeWord).toBe(DEFAULT_WAKE_WORD);
  });
});
