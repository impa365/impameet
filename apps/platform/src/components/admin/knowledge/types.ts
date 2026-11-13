import type { MessageKey } from '@/i18n/keys';
import type { IconName } from '../../ui/Icon';

export type RetrievalMode = 'hybrid' | 'semantic' | 'keyword';
export type SourceKind = 'text' | 'file' | 'url' | 'qa' | 'website' | 'page' | 'youtube';
export type SourceStatus = 'queued' | 'processing' | 'ready' | 'failed';
export type SyncInterval = 'off' | 'daily' | 'weekly';

export interface Base {
  id: string;
  name: string;
  description: string;
  embeddingIntegrationId: string | null;
  embeddingModel: string;
  dimensions: number;
  chunkSize: number;
  chunkOverlap: number;
  retrievalMode: RetrievalMode;
  topK: number;
  minScore: number;
  rerankIntegrationId: string | null;
  rerankModel: string | null;
  expandQueries: boolean;
  sources: number;
  chunks: number;
  agents: number;
  working: number;
  failed: number;
}

export interface Source {
  id: string;
  kind: SourceKind;
  title: string;
  url: string | null;
  fileName: string | null;
  status: SourceStatus;
  error: string | null;
  chunkCount: number;
  enabled: boolean;
  chars: number;
  progress: number;
  step: string;
  syncInterval: SyncInterval;
  nextSyncAt: string | null;
  meta: Record<string, unknown>;
  pages: number;
  pagesReady: number;
  pagesFailed: number;
  createdAt: string;
  processedAt: string | null;
}

export interface QaPair {
  id?: string;
  question: string;
  answer: string;
  active: boolean;
}

export interface SourceDetail extends Source {
  settings: { pairs?: QaPair[] } & Record<string, unknown>;
  log: { at: string; text: string; ok: boolean }[];
  children: {
    id: string;
    title: string;
    url: string | null;
    status: SourceStatus;
    error: string | null;
    chunkCount: number;
    enabled: boolean;
  }[];
  jobs: {
    id: string;
    reason: 'added' | 'reindex' | 'sync' | 'settings';
    status: 'running' | 'done' | 'failed';
    chunks: number;
    error: string | null;
    startedAt: string;
    finishedAt: string | null;
  }[];
}

export interface Hit {
  id: string;
  kbId: string;
  base: string;
  sourceId: string;
  title: string;
  section: string;
  content: string;
  url: string | null;
  score: number | null;
}

export interface Trace {
  base: string;
  mode: RetrievalMode;
  expanded: boolean;
  dense: number;
  sparse: number;
  reranked: boolean;
  kept: number;
  ms: number;
}

export const KIND_LABEL: Record<SourceKind, MessageKey> = {
  text: 'knowledge.kind.text',
  file: 'knowledge.kind.file',
  url: 'knowledge.kind.url',
  website: 'knowledge.kind.website',
  page: 'knowledge.kind.page',
  youtube: 'knowledge.kind.youtube',
  qa: 'knowledge.kind.qa',
};

export const KIND_ICON = {
  text: 'description',
  file: 'upload_file',
  url: 'public',
  website: 'web',
  page: 'public',
  youtube: 'smart_display',
  qa: 'quiz',
} as const satisfies Record<SourceKind, IconName>;

export const STATUS_LABEL: Record<SourceStatus, MessageKey> = {
  queued: 'knowledge.status.queued',
  processing: 'knowledge.status.processing',
  ready: 'knowledge.status.ready',
  failed: 'knowledge.status.failed',
};

export const STEP_LABEL: Record<string, MessageKey> = {
  reading: 'knowledge.status.reading',
  cutting: 'knowledge.status.cutting',
  embedding: 'knowledge.status.embedding',
  saving: 'knowledge.status.saving',
};

export const MODE_LABEL: Record<RetrievalMode, MessageKey> = {
  hybrid: 'knowledge.settings.modeHybrid',
  semantic: 'knowledge.settings.modeSemantic',
  keyword: 'knowledge.settings.modeKeyword',
};

export const SECTIONS = [
  ['sources', 'knowledge.nav.sources', 'menu_book', 'knowledge.nav.sourcesHint'],
  ['add', 'knowledge.nav.add', 'add', 'knowledge.nav.addHint'],
  ['search', 'knowledge.nav.search', 'search', 'knowledge.nav.searchHint'],
  ['chat', 'knowledge.nav.chat', 'forum', 'knowledge.nav.chatHint'],
  ['metrics', 'knowledge.nav.metrics', 'bar_chart', 'knowledge.nav.metricsHint'],
  ['settings', 'knowledge.nav.settings', 'tune', 'knowledge.nav.settingsHint'],
] as const satisfies readonly (readonly [string, MessageKey, IconName, MessageKey])[];

export type Section = (typeof SECTIONS)[number][0];

/** Where the admin is in the knowledge area, kept in the address so Back and reloads work. */
export interface KnowledgeView {
  kb?: string;
  part?: Section;
  source?: string;
}

const isSection = (v: string | null): v is Section => SECTIONS.some(([id]) => id === v);

export function viewFromUrl(): KnowledgeView {
  const p = new URLSearchParams(window.location.search);
  const part = p.get('part');
  return {
    kb: p.get('kb') ?? undefined,
    part: isSection(part) ? part : undefined,
    source: p.get('source') ?? undefined,
  };
}

export function urlFor(view: KnowledgeView): string {
  const p = new URLSearchParams(window.location.search);
  for (const key of ['kb', 'part', 'source'] as const) {
    const value = view[key];
    if (value) p.set(key, value);
    else p.delete(key);
  }
  return `${window.location.pathname}?${p.toString()}`;
}

export const kbPath = (kbId: string) => `/api/admin/knowledge/${kbId}`;

export const isWorking = (s: { status: SourceStatus }) => s.status === 'queued' || s.status === 'processing';
