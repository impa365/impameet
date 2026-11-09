-- What an AI agent does for a meeting besides talking, each off until an admin turns it on:
-- minutes after the meeting, "what did I miss?", a private copilot and meeting metrics. The
-- copilot and the metrics are for moderators and managers, or for managers only.
alter table agents
  add column insights text[] not null default '{}',
  add column insights_access text not null default 'moderators',
  add column minutes_webhook text;
alter table agents add constraint agents_insights_check
  check (insights <@ array['minutes', 'catchup', 'copilot', 'metrics']::text[]);
alter table agents add constraint agents_insights_access_check
  check (insights_access in ('moderators', 'managers'));
alter table agents add constraint agents_minutes_webhook_check
  check (minutes_webhook is null or char_length(minutes_webhook) <= 2000);

-- One per meeting an agent took part in: who was there and how much each person spoke, and
-- (with minutes on) the conversation and the minutes written from it.
create table meeting_reports (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants (id) on delete cascade,
  room_id       uuid references rooms (id) on delete set null,
  agent_id      uuid references agents (id) on delete set null,
  room_name     text not null,
  started_at    timestamptz not null,
  ended_at      timestamptz not null,
  participants  jsonb not null default '[]'::jsonb,
  lines         jsonb not null default '[]'::jsonb,
  minutes       jsonb,
  status        text not null default 'ready' check (status in ('pending', 'ready', 'failed')),
  error         text,
  delivered     jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index meeting_reports_tenant_time on meeting_reports (tenant_id, started_at desc);
create index meeting_reports_room on meeting_reports (room_id);
