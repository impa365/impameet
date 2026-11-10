'use client';

import { useT } from '@/i18n/client';
import { Icon } from '../../ui/Icon';
import type { Integration } from '../IntegrationsTab';
import { AddSource } from './AddSource';
import { ChatPanel } from './ChatPanel';
import { MetricsPanel } from './MetricsPanel';
import { SearchPanel } from './SearchPanel';
import { SettingsPanel } from './SettingsPanel';
import { SourceView } from './SourceView';
import { SourcesPanel } from './SourcesPanel';
import { type Base, type KnowledgeView, MODE_LABEL, SECTIONS } from './types';

/** One knowledge base: each part on its own page, chosen in the side menu. */
export function BaseView({
  base,
  view,
  integrations,
  go,
  onChanged,
  onBack,
}: {
  base: Base;
  view: KnowledgeView;
  integrations: Integration[];
  go: (view: KnowledgeView) => void;
  onChanged: () => Promise<void>;
  onBack: () => void;
}) {
  const t = useT();
  const part = view.part ?? 'sources';
  const to = (next: Omit<KnowledgeView, 'kb'>) => go({ kb: base.id, ...next });

  return (
    <div className="settings">
      <nav className="settings-nav" aria-label={t('knowledge.nav.label')}>
        {SECTIONS.map(([id, label, icon, hint]) => (
          <button
            key={id}
            type="button"
            aria-current={part === id && !view.source ? 'page' : undefined}
            onClick={() => to({ part: id })}
          >
            <Icon name={icon} size={18} />
            <span>
              {t(label)}
              <small>{t(hint)}</small>
            </span>
          </button>
        ))}
      </nav>
      <div className="settings-body wide">
        <div className="settings-head">
          <button type="button" className="btn text small back-link" onClick={onBack}>
            <Icon name="arrow_back" size={18} />
            {t('knowledge.list.back')}
          </button>
          <h2>{base.name}</h2>
          <span className="status-line">
            {base.embeddingModel} · {base.dimensions}d · {t(MODE_LABEL[base.retrievalMode])} ·{' '}
            {t('knowledge.sources.chunks', { count: base.chunks })}
          </span>
        </div>
        {view.source ? (
          <SourceView
            key={view.source}
            base={base}
            sourceId={view.source}
            onBack={() => to({ part: 'sources' })}
            onOpen={(id) => to({ part: 'sources', source: id })}
            onChanged={onChanged}
          />
        ) : part === 'sources' ? (
          <SourcesPanel
            base={base}
            onAdd={() => to({ part: 'add' })}
            onOpen={(id) => to({ part: 'sources', source: id })}
            onChanged={onChanged}
          />
        ) : part === 'add' ? (
          <AddSource base={base} onAdded={() => (to({ part: 'sources' }), void onChanged())} />
        ) : part === 'search' ? (
          <SearchPanel base={base} onOpen={(id) => to({ part: 'sources', source: id })} />
        ) : part === 'chat' ? (
          <ChatPanel
            base={base}
            integrations={integrations}
            onOpen={(id) => to({ part: 'sources', source: id })}
          />
        ) : part === 'metrics' ? (
          <MetricsPanel base={base} />
        ) : (
          <SettingsPanel base={base} integrations={integrations} onSaved={onChanged} />
        )}
      </div>
    </div>
  );
}
