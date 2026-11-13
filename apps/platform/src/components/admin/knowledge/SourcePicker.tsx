'use client';

import { useT } from '@/i18n/client';
import type { CapabilitySource } from './sources';

/**
 * Which integration a base uses for one capability and which of its models: an integration with
 * several (an LLM key that also embeds or reranks) always asks for the model explicitly.
 */
export function SourcePicker({
  label,
  modelLabel,
  sources,
  integrationId,
  model,
  onChange,
  noneLabel,
}: {
  label: string;
  modelLabel: string;
  sources: CapabilitySource[];
  integrationId: string;
  model: string;
  onChange: (integrationId: string, model: string) => void;
  /** Offers "none" (optional capabilities such as reranking). */
  noneLabel?: string;
}) {
  const t = useT();
  const current = sources.find((s) => s.integration.id === integrationId);
  const choose = (id: string) => {
    const next = sources.find((s) => s.integration.id === id);
    onChange(id, next?.models.length === 1 ? next.models[0] : '');
  };
  return (
    <>
      <label>
        {label}
        <select value={integrationId} onChange={(e) => choose(e.target.value)}>
          {noneLabel ? (
            <option value="">{noneLabel}</option>
          ) : (
            <option value="" disabled>
              {t('admin.agents.choose')}
            </option>
          )}
          {sources.map(({ integration: i, models, proven }) => (
            <option key={i.id} value={i.id}>
              {i.name}
              {models.length === 1
                ? ` · ${models[0]}`
                : ` · ${t('knowledge.list.modelCount', { n: models.length })}`}
              {proven ? '' : ` (${t('knowledge.list.untested')})`}
            </option>
          ))}
        </select>
      </label>
      {current && current.models.length > 1 && (
        <label>
          {modelLabel}
          <select value={model} onChange={(e) => onChange(integrationId, e.target.value)}>
            <option value="" disabled>
              {t('admin.agents.choose')}
            </option>
            {current.models.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
      )}
    </>
  );
}
