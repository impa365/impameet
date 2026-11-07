-- Open breakout rooms of a meeting (at most one session per room).
create table breakout_sessions (
  room_id      uuid primary key references rooms(id) on delete cascade,
  room_count   integer not null check (room_count between 2 and 10),
  assignments  jsonb not null default '{}'::jsonb,
  opened_by    uuid references users(id) on delete set null,
  opened_at    timestamptz not null default now()
);
