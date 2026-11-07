-- Lobby (waiting room), tenant settings and the indexes the admin screens need.

alter table tenants add column settings jsonb not null default '{}'::jsonb;

create table lobby_requests (
  id            uuid primary key default gen_random_uuid(),
  room_id       uuid not null references rooms (id) on delete cascade,
  secret_hash   bytea not null,
  display_name  text not null check (char_length(display_name) between 1 and 80),
  user_id       uuid references users (id) on delete cascade,
  status        text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  decided_by    uuid references users (id) on delete set null,
  created_at    timestamptz not null default now(),
  decided_at    timestamptz
);
create index lobby_requests_pending on lobby_requests (room_id, created_at) where status = 'pending';

create index users_tenant_created on users (tenant_id, created_at);
create index rooms_tenant_created on rooms (tenant_id, created_at desc);
