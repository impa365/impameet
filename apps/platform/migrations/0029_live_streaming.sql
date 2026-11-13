-- Where an organization's meetings and studios go live: any RTMP server (stream key sealed),
-- or a YouTube channel connected through Google (refresh token sealed). Admins manage them.
create table stream_destinations (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants (id) on delete cascade,
  kind          text not null check (kind in ('rtmp', 'youtube')),
  name          text not null check (char_length(name) between 1 and 80),
  -- RTMP: the server address, without the key
  rtmp_url      text check (rtmp_url is null or char_length(rtmp_url) <= 300),
  -- YouTube: the connected account and channel
  google_email  text check (google_email is null or char_length(google_email) <= 320),
  channel_id    text check (channel_id is null or char_length(channel_id) <= 100),
  channel_title text check (channel_title is null or char_length(channel_title) <= 200),
  secret_sealed text not null,
  secret_hint   text not null default '',
  created_by    uuid references users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index stream_destinations_tenant on stream_destinations (tenant_id);

-- One live at a time per room. `targets` keeps what to show and end (names, YouTube broadcast
-- ids, watch links); never the stream keys.
create table live_streams (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants (id) on delete cascade,
  room_id    uuid not null references rooms (id) on delete cascade,
  status     text not null check (status in ('starting', 'live', 'ended', 'failed')),
  egress_id  text,
  title      text not null default '' check (char_length(title) <= 100),
  targets    jsonb not null default '[]'::jsonb check (jsonb_typeof(targets) = 'array'),
  started_by uuid references users (id) on delete set null,
  started_at timestamptz not null default now(),
  ended_at   timestamptz,
  error      text
);

create unique index live_streams_one_per_room on live_streams (room_id) where status in ('starting', 'live');
create index live_streams_tenant on live_streams (tenant_id, started_at desc);

-- "Conectar YouTube" uses the same one-time OAuth state as Drive.
alter table oauth_states drop constraint oauth_states_purpose_check;
alter table oauth_states add constraint oauth_states_purpose_check check (purpose in ('drive', 'youtube'));
alter table oauth_states add column label text check (label is null or char_length(label) <= 80);
