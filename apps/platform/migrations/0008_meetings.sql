-- Scheduled meetings (with invitees) in an existing room.
create table meetings (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  room_id       uuid not null references rooms(id) on delete cascade,
  title         text not null,
  description   text not null default '',
  starts_at     timestamptz not null,
  duration_min  integer not null check (duration_min between 5 and 1440),
  invitees      text[] not null default '{}',
  created_by    uuid references users(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index meetings_tenant_start_idx on meetings (tenant_id, starts_at);
