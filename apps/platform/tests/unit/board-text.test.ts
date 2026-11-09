import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BoardText, changeSentence, itemSentence } from '@/components/BoardText';
import { I18nProvider, type T } from '@/i18n/client';
import { translate } from '@/i18n/format';
import type { MessageKey } from '@/i18n/keys';
import { messagesFor } from '@/i18n/messages';
import { DEFAULT_A11Y, parseA11yPrefs } from '@/lib/a11y';
import {
  ALL_DELAY_MS,
  type BoardChange,
  ChangeDigest,
  type Known,
  SUMMARY_INTERVAL_MS,
  boardItems,
  describeUpdate,
  rememberBoard,
  withDescription,
} from '@/lib/board-text';
import type { SyncElement } from '@/lib/whiteboard-sync';

const el = (id: string, type: string, extra: Record<string, unknown> = {}): SyncElement => ({
  id,
  type,
  version: 1,
  versionNonce: 1,
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  ...extra,
});

const BOARD = [
  el('box', 'rectangle', { x: 0, y: 0, width: 100, height: 50 }),
  el('label', 'text', { text: 'Vendas', containerId: 'box' }),
  el('goal', 'ellipse', { x: 900, y: 600, width: 100, height: 100 }),
  el('arrow', 'arrow', {
    x: 100,
    y: 25,
    width: 800,
    height: 600,
    startBinding: { elementId: 'box' },
    endBinding: { elementId: 'goal' },
  }),
  el('pic', 'image', { x: 450, y: 300, width: 100, height: 50 }),
  el('sketch', 'freedraw', { x: 0, y: 650, width: 50, height: 50, customData: { alt: 'Uma estrela' } }),
  el('gone', 'diamond', { isDeleted: true }),
  el('weird', 'magicframe', { x: 950, y: 0, width: 50, height: 10 }),
];

const pt = messagesFor('pt-BR');
const t: T = (key: MessageKey, vars) => translate(pt, key, vars);

describe('the whiteboard as text', () => {
  it('lists what is visible in reading order, with texts, places, links and authors', () => {
    const items = boardItems(BOARD, new Map([['box', 'Ana']]));
    expect(items.map((i) => [i.id, i.row, i.col])).toEqual([
      ['box', 'top', 'left'],
      ['weird', 'top', 'right'],
      ['arrow', 'middle', 'center'],
      ['pic', 'middle', 'center'],
      ['sketch', 'bottom', 'left'],
      ['goal', 'bottom', 'right'],
    ]);
    const [box, frame, arrow, pic, sketch] = items;
    expect(box).toMatchObject({ kind: 'rectangle', text: 'Vendas', author: 'Ana' });
    expect(frame.kind).toBe('frame');
    expect(arrow).toMatchObject({
      kind: 'arrow',
      from: { text: 'Vendas', kind: 'rectangle' },
      to: { text: '', kind: 'ellipse' },
    });
    expect(pic.alt).toBe('');
    expect(sketch.alt).toBe('Uma estrela');
    expect(boardItems([el('x', 'rectangle', { isDeleted: true })], new Map())).toEqual([]);
    expect(boardItems([el('odd', 'something-new', { x: Number.NaN })], new Map())[0]).toMatchObject({
      kind: 'other',
      row: 'middle',
      col: 'center',
    });
  });

  it('reads each element as one sentence, flagging what has no description', () => {
    const items = boardItems(BOARD, new Map([['box', 'Ana']]));
    expect(itemSentence(t, items[0])).toBe('Retângulo “Vendas”, em cima, à esquerda, por Ana');
    expect(itemSentence(t, items[2])).toBe('Seta, liga “Vendas” a elipse, no centro');
    expect(itemSentence(t, items[3])).toBe('Imagem (sem descrição), no centro');
    expect(itemSentence(t, items[4])).toBe('Desenho à mão livre: Uma estrela, embaixo, à esquerda');
    const en = messagesFor('en');
    const tEn: T = (key, vars) => translate(en, key, vars);
    expect(itemSentence(tEn, items[5])).toBe('Ellipse, bottom right');
  });

  it('tells what an update adds, changes or deletes, and by whom', () => {
    const known = new Map<string, Known>();
    const first = describeUpdate(known, [el('a', 'text', { text: 'Meta' }), el('b', 'rectangle')], 'Ana', 5);
    expect(first).toEqual({ author: 'Ana', added: 2, changed: 0, removed: 0, texts: ['Meta'], at: 5 });
    rememberBoard(known, [el('a', 'text'), el('b', 'rectangle')]);
    expect(describeUpdate(known, [el('a', 'text')], 'Ana')).toBeNull(); // same version: nothing new
    const next = describeUpdate(
      known,
      [
        { ...el('a', 'text'), version: 2 },
        { ...el('b', 'rectangle'), version: 2, isDeleted: true },
        { ...el('c', 'line'), isDeleted: true },
      ],
      'Bia',
    );
    expect(next).toMatchObject({ added: 0, changed: 1, removed: 1 });
    rememberBoard(known, [{ ...el('b', 'rectangle'), version: 2, isDeleted: true }]);
    expect(describeUpdate(known, [{ ...el('b', 'rectangle'), version: 3 }], 'Caio')).toMatchObject({
      added: 1,
    });
    rememberBoard(known, [{ ...el('b', 'rectangle'), version: 1 }]); // older: ignored
    expect(known.get('b')?.version).toBe(2);
  });

  it('phrases changes naturally in each language', () => {
    const c = (patch: Partial<BoardChange>): BoardChange => ({
      author: 'Ana',
      added: 0,
      changed: 0,
      removed: 0,
      texts: [],
      at: 0,
      ...patch,
    });
    expect(changeSentence(t, c({ added: 1, texts: ['Meta'] }))).toBe('Ana escreveu “Meta”.');
    expect(changeSentence(t, c({ added: 1 }))).toBe('Ana adicionou um elemento.');
    expect(changeSentence(t, c({ added: 3, changed: 1, removed: 2 }))).toBe(
      'Ana adicionou 3 elementos, mudou um elemento e apagou 2 elementos.',
    );
    expect(changeSentence(t, c({ changed: 2, removed: 1 }))).toBe(
      'Ana mudou 2 elementos e apagou um elemento.',
    );
  });

  it('gathers bursts of changes and never speaks more often than chosen', () => {
    const d = new ChangeDigest();
    const change = (author: string, at: number): BoardChange => ({
      author,
      added: 1,
      changed: 0,
      removed: 0,
      texts: [`t${at}`],
      at,
    });
    expect(d.dueAt('all', 0)).toBeNull();
    d.add(change('Ana', 1000));
    d.add(change('Ana', 1500));
    d.add(change('Bia', 1600));
    expect(d.dueAt('off', 1600)).toBeNull();
    expect(d.dueAt('all', 1600)).toBe(1600 + ALL_DELAY_MS);
    const said = d.take(5000);
    expect(said.map((c) => [c.author, c.added, c.texts])).toEqual([
      ['Ana', 2, ['t1000', 't1500']],
      ['Bia', 1, ['t1600']],
    ]);
    d.add(change('Ana', 6000));
    expect(d.dueAt('summary', 6000)).toBe(5000 + SUMMARY_INTERVAL_MS);
    expect(d.dueAt('all', 99999)).toBe(99999);
    d.clear();
    expect(d.take(7000)).toEqual([]);
  });

  it('adds a description as a new version, so every browser takes it', () => {
    const before = el('pic', 'image', { customData: { keep: 1 } });
    const after = withDescription(before, `  ${'x'.repeat(600)}  `);
    expect(after.version).toBe(2);
    expect((after.customData as { alt: string; keep: number }).alt).toHaveLength(500);
    expect((after.customData as { keep: number }).keep).toBe(1);
    expect(withDescription(el('a', 'freedraw'), 'Estrela').customData).toEqual({ alt: 'Estrela' });
  });

  it('remembers the announcement choice', () => {
    expect(DEFAULT_A11Y.boardAnnounce).toBe('summary');
    expect(parseA11yPrefs('{"boardAnnounce": "off"}').boardAnnounce).toBe('off');
    expect(parseA11yPrefs('{"boardAnnounce": "loud"}').boardAnnounce).toBe('summary');
  });
});

describe('the whiteboard text view (ARIA)', () => {
  const render = (elements: SyncElement[], canDescribe: boolean, changes: BoardChange[] = []) =>
    renderToStaticMarkup(
      createElement(
        I18nProvider,
        { locale: 'pt-BR', messages: pt, serverErrors: {} } as Parameters<typeof I18nProvider>[0],
        createElement(BoardText, {
          board: {
            elements: { current: elements },
            authors: { current: new Map([['box', 'Ana']]) },
            changes,
            revision: 1,
            describe: () => undefined,
          },
          canDescribe,
        }),
      ),
    );

  it('is a named, explained list where only one item is in the tab order', () => {
    const html = render(BOARD, true, [
      { author: 'Bia', added: 1, changed: 0, removed: 0, texts: ['Meta'], at: Date.UTC(2026, 10, 9, 15, 4) },
    ]);
    expect(html).toContain('<details class="board-text">');
    expect(html).toContain(
      '<summary id="board-text-summary">Descrição do quadro em texto: 6 elementos</summary>',
    );
    expect(html).toMatch(
      /<ul class="board-items" aria-label="Elementos do quadro" aria-describedby="board-text-help">/,
    );
    expect(html).toContain('id="board-text-help"');
    expect(html.match(/<li tabindex="0"/g)).toHaveLength(1);
    expect(html.match(/<li tabindex="-1"/g)).toHaveLength(5);
    expect(html).toContain('aria-label="Descrever: Retângulo “Vendas”, em cima, à esquerda, por Ana"');
    expect(html).toContain('Mudar a descrição');
    expect(html).toContain('<ol class="board-changes" aria-label="Alterações recentes">');
    expect(html).toContain('Bia escreveu “Meta”.');
    expect(html).toMatch(/<time dateTime="2026-11-09T15:04:00.000Z">/);
  });

  it('has nothing to describe for viewers who cannot draw, and says when the board is empty', () => {
    expect(render(BOARD, false)).not.toContain('Descrever');
    const empty = render([], false);
    expect(empty).toContain('Descrição do quadro em texto: vazio');
    expect(empty).toContain('O quadro está vazio.');
    expect(empty).toContain('Nenhuma alteração desde que você entrou.');
  });
});
