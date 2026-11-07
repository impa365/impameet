-- Meeting transcripts saved by the live-captions worker when it leaves a room.
create table transcripts (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  room_id     uuid references rooms(id) on delete set null,
  room_name   text not null,
  started_by  uuid references users(id) on delete set null,
  started_at  timestamptz not null,
  ended_at    timestamptz not null,
  lines       jsonb not null,
  line_count  integer not null
);

create index transcripts_tenant_started_idx on transcripts (tenant_id, started_at desc);

-- Who switched captions on, so members can find the transcripts of their own meetings.
create table caption_sessions (
  room_id     uuid primary key references rooms(id) on delete cascade,
  started_by  uuid references users(id) on delete set null,
  started_at  timestamptz not null default now()
);
