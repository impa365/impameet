-- Knowledge bases, second round: how each base cuts and searches, more kinds of source
-- (a whole website, YouTube videos), live progress, scheduled re-sync, pieces that can be
-- switched off or corrected, a history of runs and the searches behind the usage metrics.

-- Rerankers (Cohere / Jina / Voyage style /rerank APIs) are integrations the admin adds.
alter table integrations drop constraint integrations_kind_check;
alter table integrations add constraint integrations_kind_check
  check (kind in ('llm', 'fish', 'deepgram', 'elevenlabs', 'embedding', 'rerank'));

alter table knowledge_bases
  add column chunk_size integer not null default 1200 check (chunk_size between 200 and 4000),
  add column chunk_overlap integer not null default 150 check (chunk_overlap between 0 and 1000),
  add column retrieval_mode text not null default 'hybrid'
    check (retrieval_mode in ('hybrid', 'semantic', 'keyword')),
  add column top_k integer not null default 5 check (top_k between 1 and 20),
  add column min_score real not null default 0 check (min_score between 0 and 1),
  add column rerank_integration_id uuid references integrations (id) on delete set null,
  add column expand_queries boolean not null default true;

-- A website is a source whose pages are child sources ("page"); deleting it removes them.
alter table knowledge_sources drop constraint knowledge_sources_kind_check;
alter table knowledge_sources add constraint knowledge_sources_kind_check
  check (kind in ('text', 'file', 'url', 'qa', 'website', 'page', 'youtube'));

alter table knowledge_sources
  add column parent_id uuid references knowledge_sources (id) on delete cascade,
  add column settings jsonb not null default '{}',
  add column meta jsonb not null default '{}',
  add column sync_interval text not null default 'off' check (sync_interval in ('off', 'daily', 'weekly')),
  add column next_sync_at timestamptz,
  add column progress integer not null default 0 check (progress between 0 and 100),
  add column step text not null default '',
  add column log jsonb not null default '[]';

create index knowledge_sources_parent on knowledge_sources (parent_id) where parent_id is not null;
create index knowledge_sources_sync on knowledge_sources (next_sync_at) where sync_interval <> 'off';

alter table knowledge_chunks
  add column enabled boolean not null default true,
  add column edited boolean not null default false,
  add column hits integer not null default 0;

-- One row per indexing run of a source (the last few are shown next to it).
create table knowledge_jobs (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete cascade,
  kb_id       uuid not null references knowledge_bases (id) on delete cascade,
  source_id   uuid not null references knowledge_sources (id) on delete cascade,
  reason      text not null check (reason in ('added', 'reindex', 'sync', 'settings')),
  status      text not null default 'running' check (status in ('running', 'done', 'failed')),
  chunks      integer not null default 0,
  error       text,
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);

create index knowledge_jobs_source on knowledge_jobs (source_id, started_at desc);

-- Searches, for the usage metrics. Kept 30 days; the question text is cut to 500 characters.
create table knowledge_searches (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants (id) on delete cascade,
  kb_ids     uuid[] not null,
  agent_id   uuid references agents (id) on delete set null,
  origin     text not null check (origin in ('agent', 'test', 'chat')),
  query      text not null check (char_length(query) <= 500),
  hits       integer not null,
  top_score  real,
  latency_ms integer not null,
  created_at timestamptz not null default now()
);

create index knowledge_searches_tenant on knowledge_searches (tenant_id, created_at desc);
