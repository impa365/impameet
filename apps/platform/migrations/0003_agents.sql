-- AI agents configured per organization, and the agent each room calls.

create table agents (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants (id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 60),
  instructions  text not null check (char_length(instructions) between 1 and 20000),
  knowledge     text not null default '' check (char_length(knowledge) <= 100000),
  greeting      text not null default '' check (char_length(greeting) <= 500),
  voice_id      text check (voice_id is null or voice_id ~ '^[A-Za-z0-9_-]{4,64}$'),
  tts_model     text not null default 's2.1-pro' check (tts_model ~ '^[a-z0-9._-]{1,40}$'),
  llm_model     text check (llm_model is null or char_length(llm_model) between 1 and 120),
  listen_mode   text not null default 'everyone' check (listen_mode in ('everyone', 'moderators', 'members')),
  respond_mode  text not null default 'always' check (respond_mode in ('always', 'when_named')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, name)
);

alter table rooms add column agent_id uuid references agents (id) on delete set null;
