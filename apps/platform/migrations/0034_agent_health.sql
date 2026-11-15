-- Runtime health of voice agents: why they stayed quiet or failed (no transcripts).
create table agent_session_events (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete cascade,
  agent_id    uuid not null references agents (id) on delete cascade,
  room_name   text not null,
  session_id  text,
  at          timestamptz not null default now(),
  kind        text not null,
  code        text not null,
  source      text,
  detail      text,
  constraint agent_session_events_kind_check check (
    kind in (
      'joined', 'left', 'rejected', 'pipeline_error',
      'skipped_reply', 'muted', 'unmuted', 'answered'
    )
  ),
  constraint agent_session_events_code_check check (char_length(code) between 1 and 40),
  constraint agent_session_events_room_check check (char_length(room_name) between 1 and 200),
  constraint agent_session_events_source_check check (source is null or char_length(source) <= 40),
  constraint agent_session_events_detail_check check (detail is null or char_length(detail) <= 200)
);

create index agent_session_events_agent_time on agent_session_events (agent_id, at desc);
create index agent_session_events_tenant_time on agent_session_events (tenant_id, at desc);

-- Drop rows older than 14 days (called from the health service / retention).
comment on table agent_session_events is
  'Append-only health trail for voice agents; no conversation content.';
