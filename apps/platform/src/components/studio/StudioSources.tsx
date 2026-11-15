'use client';

import { useState } from 'react';
import { useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/keys';
import {
  SOURCE_PRESETS,
  type StudioSource,
  type StudioBrowserSource,
  type StudioClockSource,
  type StudioImageSource,
  type StudioTextSource,
} from '@/lib/studio';
import { Icon } from '../ui/Icon';
import type { StudioControl } from './StudioRoom';

const TYPE_LABEL: Record<StudioSource['type'], MessageKey> = {
  browser: 'studio.sources.browser',
  image: 'studio.sources.image',
  text: 'studio.sources.text',
  clock: 'studio.sources.clock',
};

export function StudioSourcesPanel(props: { control: StudioControl }) {
  const t = useT();
  const { preview, addSource, patchSource, removeSource } = props.control;
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="studio-sources-panel">
      <h4>{t('studio.sources.title')}</h4>
      <p className="muted small-print">{t('studio.sources.intro')}</p>
      <div className="studio-presets">
        {SOURCE_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className="btn tonal small"
            onClick={() => {
              const src = p.build();
              addSource(src);
              setOpenId(src.id);
            }}
          >
            <Icon name="add" size={16} />
            {t(p.labelKey as MessageKey)}
          </button>
        ))}
      </div>
      {preview.sources.length === 0 ? (
        <p className="muted">{t('studio.sources.empty')}</p>
      ) : (
        <ul className="studio-source-list">
          {[...preview.sources]
            .sort((a, b) => b.z - a.z || a.name.localeCompare(b.name))
            .map((src) => (
              <li key={src.id} className={openId === src.id ? 'open' : undefined}>
                <div className="studio-source-row">
                  <button
                    type="button"
                    className="studio-source-toggle"
                    aria-pressed={src.visible}
                    title={src.visible ? t('studio.sources.hide') : t('studio.sources.show')}
                    onClick={() => patchSource(src.id, { visible: !src.visible })}
                  >
                    <Icon name={src.visible ? 'visibility' : 'visibility_off'} size={18} />
                  </button>
                  <button type="button" className="studio-source-pick" onClick={() => setOpenId(src.id)}>
                    <strong>{src.name}</strong>
                    <small>{t(TYPE_LABEL[src.type])}</small>
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={t('studio.sources.layerUp')}
                    title={t('studio.sources.layerUp')}
                    onClick={() => patchSource(src.id, { z: Math.min(100, src.z + 1) })}
                  >
                    <Icon name="arrow_upward" size={16} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={t('studio.sources.layerDown')}
                    title={t('studio.sources.layerDown')}
                    onClick={() => patchSource(src.id, { z: Math.max(0, src.z - 1) })}
                  >
                    <Icon name="arrow_downward" size={16} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={t('studio.sources.remove')}
                    onClick={() => removeSource(src.id)}
                  >
                    <Icon name="delete" size={18} />
                  </button>
                </div>
                {openId === src.id && (
                  <SourceEditor source={src} onChange={(patch) => patchSource(src.id, patch)} />
                )}
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

function SourceEditor(props: { source: StudioSource; onChange: (patch: Partial<StudioSource>) => void }) {
  const t = useT();
  const { source, onChange } = props;
  return (
    <div className="studio-source-editor">
      <label>
        {t('studio.sources.name')}
        <input className="field" value={source.name} onChange={(e) => onChange({ name: e.target.value })} />
      </label>
      {source.type === 'browser' && (
        <>
          <label>
            {t('studio.sources.url')}
            <input
              className="field"
              type="url"
              value={(source as StudioBrowserSource).url}
              placeholder="https://…"
              onChange={(e) => onChange({ url: e.target.value } as Partial<StudioBrowserSource>)}
            />
          </label>
          <p className="muted small-print">{t('studio.sources.urlHelp')}</p>
          <label className="switch">
            <input
              type="checkbox"
              checked={(source as StudioBrowserSource).muted}
              onChange={(e) => onChange({ muted: e.target.checked } as Partial<StudioBrowserSource>)}
            />
            <span>{t('studio.sources.mute')}</span>
          </label>
        </>
      )}
      {source.type === 'image' && (
        <label>
          {t('studio.sources.imageUrl')}
          <input
            className="field"
            type="url"
            value={(source as StudioImageSource).url}
            placeholder="https://…"
            onChange={(e) => onChange({ url: e.target.value } as Partial<StudioImageSource>)}
          />
        </label>
      )}
      {source.type === 'text' && (
        <>
          <label>
            {t('studio.sources.body')}
            <textarea
              className="field"
              rows={2}
              value={(source as StudioTextSource).text}
              onChange={(e) => onChange({ text: e.target.value } as Partial<StudioTextSource>)}
            />
          </label>
          <TextLook
            color={(source as StudioTextSource).color}
            background={(source as StudioTextSource).background}
            align={(source as StudioTextSource).align}
            size={(source as StudioTextSource).size}
            onChange={onChange}
          />
        </>
      )}
      {source.type === 'clock' && (
        <>
          <label>
            {t('studio.sources.clockFormat')}
            <select
              className="field"
              value={(source as StudioClockSource).format}
              onChange={(e) =>
                onChange({
                  format: e.target.value as StudioClockSource['format'],
                } as Partial<StudioClockSource>)
              }
            >
              <option value="time">{t('studio.sources.clockTime')}</option>
              <option value="seconds">{t('studio.sources.clockSeconds')}</option>
              <option value="date">{t('studio.sources.clockDate')}</option>
            </select>
          </label>
          <TextLook
            color={(source as StudioClockSource).color}
            background={(source as StudioClockSource).background}
            align={(source as StudioClockSource).align}
            size={(source as StudioClockSource).size}
            onChange={onChange}
          />
        </>
      )}
      <fieldset className="studio-box-fields">
        <legend>{t('studio.sources.position')}</legend>
        {(['x', 'y', 'w', 'h'] as const).map((k) => (
          <label key={k}>
            {k.toUpperCase()}
            <input
              type="number"
              min={0}
              max={100}
              step={1}
              value={Math.round(source.box[k])}
              onChange={(e) => onChange({ box: { ...source.box, [k]: Number(e.target.value) } })}
            />
          </label>
        ))}
      </fieldset>
      <label>
        {t('studio.sources.opacity')}
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(source.opacity * 100)}
          onChange={(e) => onChange({ opacity: Number(e.target.value) / 100 })}
        />
      </label>
      <label>
        {t('studio.sources.layer')}
        <input
          type="number"
          min={0}
          max={100}
          value={source.z}
          onChange={(e) => onChange({ z: Number(e.target.value) })}
        />
      </label>
    </div>
  );
}

function TextLook(props: {
  color: string;
  background: string;
  align: 'left' | 'center' | 'right';
  size: number;
  onChange: (patch: Partial<StudioSource>) => void;
}) {
  const t = useT();
  const { onChange } = props;
  return (
    <>
      <div className="row">
        <label>
          {t('studio.sources.textColor')}
          <input
            type="color"
            value={props.color.slice(0, 7)}
            onChange={(e) => onChange({ color: e.target.value })}
          />
        </label>
        <label>
          {t('studio.sources.bgColor')}
          <input
            type="color"
            value={props.background.slice(0, 7)}
            onChange={(e) => onChange({ background: `${e.target.value}cc` })}
          />
        </label>
        <label>
          {t('studio.sources.size')}
          <input
            type="number"
            min={12}
            max={96}
            value={props.size}
            onChange={(e) => onChange({ size: Number(e.target.value) })}
          />
        </label>
      </div>
      <label>
        {t('studio.sources.align')}
        <select
          className="field"
          value={props.align}
          onChange={(e) => onChange({ align: e.target.value as 'left' | 'center' | 'right' })}
        >
          <option value="left">{t('studio.sources.alignLeft')}</option>
          <option value="center">{t('studio.sources.alignCenter')}</option>
          <option value="right">{t('studio.sources.alignRight')}</option>
        </select>
      </label>
    </>
  );
}
