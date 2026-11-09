-- Knowledge bases (RAG): documents an organization's agents can look things up in. The text
-- and its pieces live here; their vectors live in Qdrant, one collection per base. Embeddings
-- come from an integration the admin chose (there is no server default).
alter table integrations drop constraint integrations_kind_check;
alter table integrations add constraint integrations_kind_check
  check (kind in ('llm', 'fish', 'deepgram', 'elevenlabs', 'embedding'));

create table knowledge_bases (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references tenants (id) on delete cascade,
  name                     text not null check (char_length(name) between 1 and 80),
  description              text not null default '' check (char_length(description) <= 500),
  embedding_integration_id uuid references integrations (id) on delete set null,
  embedding_model          text not null check (char_length(embedding_model) between 1 and 120),
  dimensions               integer not null check (dimensions between 8 and 8192),
  collection               text not null unique,
  created_by               uuid references users (id) on delete set null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (tenant_id, name)
);

create table knowledge_sources (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants (id) on delete cascade,
  kb_id        uuid not null references knowledge_bases (id) on delete cascade,
  kind         text not null check (kind in ('text', 'file', 'url', 'qa')),
  title        text not null check (char_length(title) between 1 and 200),
  url          text check (char_length(url) <= 2000),
  file_name    text check (char_length(file_name) <= 255),
  content      text not null default '',
  content_hash text not null default '',
  status       text not null default 'queued'
               check (status in ('queued', 'processing', 'ready', 'failed')),
  error        text,
  chunk_count  integer not null default 0,
  enabled      boolean not null default true,
  created_by   uuid references users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  processed_at timestamptz
);

create index knowledge_sources_kb on knowledge_sources (kb_id, created_at desc);
create index knowledge_sources_pending on knowledge_sources (status) where status in ('queued', 'processing');

-- Each piece's id is its point id in Qdrant.
create table knowledge_chunks (
  id         uuid primary key,
  tenant_id  uuid not null references tenants (id) on delete cascade,
  kb_id      uuid not null references knowledge_bases (id) on delete cascade,
  source_id  uuid not null references knowledge_sources (id) on delete cascade,
  idx        integer not null,
  section    text not null default '',
  content    text not null
);

create index knowledge_chunks_source on knowledge_chunks (source_id, idx);

create table agent_knowledge (
  agent_id uuid not null references agents (id) on delete cascade,
  kb_id    uuid not null references knowledge_bases (id) on delete cascade,
  primary key (agent_id, kb_id)
);

-- "Training" that works with any LLM: answers the admin approved, shown to the model as
-- examples, and style rules it always follows.
alter table agents add column style_rules text not null default ''
  check (char_length(style_rules) <= 2000);

create table agent_examples (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants (id) on delete cascade,
  agent_id   uuid not null references agents (id) on delete cascade,
  question   text not null check (char_length(question) between 1 and 1000),
  answer     text not null check (char_length(answer) between 1 and 2000),
  enabled    boolean not null default true,
  created_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index agent_examples_agent on agent_examples (agent_id, created_at);
