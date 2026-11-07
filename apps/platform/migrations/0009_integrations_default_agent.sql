-- Provider credentials per organization (several keys per provider), referenced by agents.
-- API keys are stored sealed (AES-256-GCM, master key outside the database); only a hint
-- with the last 4 characters is ever shown.
create table integrations (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  kind             text not null check (kind in ('llm', 'fish')),
  name             text not null,
  base_url         text,
  default_model    text,
  models           text[] not null default '{}',
  secret_sealed    text not null,
  secret_hint      text not null,
  last_tested_at   timestamptz,
  last_test_ok     boolean,
  last_test_error  text,
  created_by       uuid references users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, name)
);

create index integrations_tenant_kind_idx on integrations (tenant_id, kind);

alter table agents
  add column llm_integration_id uuid references integrations(id) on delete set null,
  add column fish_integration_id uuid references integrations(id) on delete set null,
  add column is_default boolean not null default false;

create unique index agents_one_default_per_tenant on agents (tenant_id) where is_default;

-- The main agent used to live only in the server configuration, so nobody could edit it.
-- Every organization now gets it as a regular, editable agent marked as the default.
update agents set is_default = true
where id in (
  select distinct on (tenant_id) id from agents
  where lower(name) = 'kaiser'
  order by tenant_id, created_at
);

insert into agents (tenant_id, name, instructions, is_default)
select t.id, 'Kaiser',
  'Você é Kaiser, um assistente de voz participando de uma reunião ao vivo. '
  || 'Fale sempre em português do Brasil, como numa conversa. '
  || 'Responda em uma ou duas frases curtas, com no máximo vinte e cinco palavras, '
  || 'a menos que peçam explicitamente mais detalhes. Vá direto ao ponto, sem introduções. '
  || 'Nunca use emojis, markdown, listas ou símbolos especiais: tudo o que você escreve será falado. '
  || 'Se não souber algo, diga que não sabe.',
  true
from tenants t
where not exists (select 1 from agents a where a.tenant_id = t.id and a.is_default);
