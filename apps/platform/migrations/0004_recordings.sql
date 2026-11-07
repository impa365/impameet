-- Meeting recordings (LiveKit Egress writes the file; the platform tracks and serves it).
create table recordings (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  room_id     uuid references rooms(id) on delete set null,
  room_name   text not null,
  egress_id   text unique,
  status      text not null default 'starting'
              check (status in ('starting', 'recording', 'processing', 'ready', 'failed')),
  file_name   text not null,
  size_bytes  bigint,
  duration_s  integer,
  error       text,
  started_by  uuid references users(id) on delete set null,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz
);

create index recordings_tenant_started_idx on recordings (tenant_id, started_at desc);
create unique index recordings_one_active_per_room on recordings (room_id)
  where status in ('starting', 'recording');
