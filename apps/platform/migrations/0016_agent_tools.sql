-- External tools an AI agent may use: HTTP requests and remote MCP servers. The platform makes
-- every call itself (the voice worker never sees these secrets) and only for the people the tool
-- allows: moderators, or signed-in members of the organization. Guests never.
create table agent_tools (
  id             uuid primary key,
  tenant_id      uuid not null references tenants (id) on delete cascade,
  agent_id       uuid not null references agents (id) on delete cascade,
  kind           text not null check (kind in ('http', 'mcp')),
  name           text not null check (name ~ '^[a-z][a-z0-9_]{1,39}$'),
  description    text not null default '' check (char_length(description) <= 1000),
  enabled        boolean not null default true,
  access         text not null default 'moderators' check (access in ('moderators', 'members')),
  confirm        boolean not null default true,
  url            text not null check (char_length(url) <= 2000),
  method         text check (method in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
  params         jsonb not null default '[]'::jsonb,
  body_template  text check (char_length(body_template) <= 8000),
  mcp_tools      text[] not null default '{}',
  timeout_ms     integer not null default 10000 check (timeout_ms between 1000 and 30000),
  headers_sealed text,
  header_names   text[] not null default '{}',
  created_by     uuid references users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (agent_id, name),
  check ((kind = 'http') = (method is not null))
);

create index agent_tools_tenant on agent_tools (tenant_id);
