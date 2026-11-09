'use client';

import { useMemo, useState } from 'react';
import { useT } from '@/i18n/client';
import { type ModelCategory, categoryCounts, filterModels, modelCategory } from '@/lib/models';

const CATEGORY_LABEL = {
  chat: 'admin.integrations.catChat',
  reasoning: 'admin.integrations.catReasoning',
  code: 'admin.integrations.catCode',
  embedding: 'admin.integrations.catEmbedding',
  audio: 'admin.integrations.catAudio',
  image: 'admin.integrations.catImage',
  other: 'admin.integrations.catOther',
} as const;

/**
 * Every model the key can use, to tick the ones the agents may choose and pick the main one.
 * Models already enabled stay listed even if the provider no longer returns them.
 */
export function ModelPicker({
  available,
  selected,
  principal,
  onSelected,
  onPrincipal,
}: {
  available: string[];
  selected: string[];
  principal: string;
  onSelected: (models: string[]) => void;
  /** Also ticks the model. */
  onPrincipal: (model: string) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<ModelCategory | 'all'>('all');
  const [onlySelected, setOnlySelected] = useState(false);
  const all = useMemo(() => [...new Set([...available, ...selected])].sort(), [available, selected]);
  const chosen = new Set(selected);
  const visible = filterModels(onlySelected ? all.filter((m) => chosen.has(m)) : all, query, category);

  const toggle = (model: string, on: boolean) =>
    onSelected(on ? [...selected, model] : selected.filter((m) => m !== model));
  const markVisible = (on: boolean) => {
    const shown = new Set(visible);
    onSelected(on ? [...new Set([...selected, ...visible])] : selected.filter((m) => !shown.has(m)));
  };

  return (
    <fieldset className="group model-picker">
      <legend>{t('admin.integrations.pickerLegend')}</legend>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('admin.integrations.searchModels')}
        aria-label={t('admin.integrations.searchModels')}
      />
      <div className="chips" role="group" aria-label={t('admin.integrations.categories')}>
        <button
          type="button"
          className={category === 'all' ? 'chip add accent' : 'chip add'}
          aria-pressed={category === 'all'}
          onClick={() => setCategory('all')}
        >
          {t('admin.integrations.catAll')} · {all.length}
        </button>
        {categoryCounts(all).map(([c, n]) => (
          <button
            key={c}
            type="button"
            className={category === c ? 'chip add accent' : 'chip add'}
            aria-pressed={category === c}
            onClick={() => setCategory(c)}
          >
            {t(CATEGORY_LABEL[c])} · {n}
          </button>
        ))}
      </div>
      <div className="row model-picker-tools">
        <span className="muted" role="status">
          {t('admin.integrations.selectedCount', { n: selected.length, total: all.length })}
        </span>
        <button
          type="button"
          className="btn secondary small"
          disabled={visible.length === 0}
          onClick={() => markVisible(true)}
        >
          {t('admin.integrations.selectVisible', { n: visible.length })}
        </button>
        <button
          type="button"
          className="btn secondary small"
          disabled={!visible.some((m) => chosen.has(m))}
          onClick={() => markVisible(false)}
        >
          {t('admin.integrations.clearVisible')}
        </button>
        <label className="model-picker-only">
          <input type="checkbox" checked={onlySelected} onChange={(e) => setOnlySelected(e.target.checked)} />
          {t('admin.integrations.onlySelected')}
        </label>
      </div>
      <ul className="model-list">
        {visible.length === 0 && <li className="muted">{t('admin.integrations.noMatch')}</li>}
        {visible.map((m) => (
          <li key={m} className={m === principal ? 'principal' : undefined}>
            <label>
              <input type="checkbox" checked={chosen.has(m)} onChange={(e) => toggle(m, e.target.checked)} />
              <span className="model-id">{m}</span>
              <span className="chip">{t(CATEGORY_LABEL[modelCategory(m)])}</span>
            </label>
            {m === principal ? (
              <span className="pill ok">{t('admin.integrations.principal')}</span>
            ) : (
              <button
                type="button"
                className="btn secondary small"
                aria-label={t('admin.integrations.makePrincipal', { model: m })}
                onClick={() => onPrincipal(m)}
              >
                {t('admin.integrations.usePrincipal')}
              </button>
            )}
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
