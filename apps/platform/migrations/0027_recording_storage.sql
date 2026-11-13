-- The platform's Google OAuth client (Drive now, YouTube next), set by the super admin.
-- The secret is sealed with the server's encryption key and never shown again.
create table platform_google (
  id                   boolean primary key default true check (id),
  client_id            text not null check (char_length(client_id) between 10 and 200),
  client_secret_sealed text not null,
  updated_by           uuid references users (id) on delete set null,
  updated_at           timestamptz not null default now()
);

-- Where an organization's recordings go once they are ready. The platform uploads them (the
-- recorder never sees these credentials). One destination per organization.
create table recording_storage (
  tenant_id       uuid primary key references tenants (id) on delete cascade,
  kind            text not null check (kind in ('s3', 'gdrive')),
  -- S3 and compatible services
  endpoint        text check (endpoint is null or char_length(endpoint) <= 300),
  region          text check (region is null or char_length(region) <= 60),
  bucket          text check (bucket is null or bucket ~ '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'),
  prefix          text not null default '' check (char_length(prefix) <= 200),
  path_style      boolean not null default false,
  access_key      text check (access_key is null or char_length(access_key) <= 200),
  -- Google Drive
  google_email    text check (google_email is null or char_length(google_email) <= 320),
  folder_id       text check (folder_id is null or char_length(folder_id) <= 200),
  folder_name     text check (folder_name is null or char_length(folder_name) <= 120),
  -- The S3 secret key, or the Google refresh token
  secret_sealed   text not null,
  secret_hint     text not null default '',
  keep_local      boolean not null,
  last_test_at    timestamptz,
  last_test_ok    boolean,
  last_test_error text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table recordings
  add column storage_kind     text check (storage_kind in ('s3', 'gdrive')),
  add column storage_status   text check (storage_status in ('pending', 'uploading', 'done', 'failed')),
  add column storage_ref      text,
  add column storage_link     text,
  add column storage_error    text,
  add column storage_attempts integer not null default 0,
  add column storage_next_at  timestamptz,
  add column local_removed    boolean not null default false;

create index recordings_storage_due on recordings (storage_next_at)
  where storage_status in ('pending', 'failed');

-- "Conectar com Google": one-time, short-lived, bound to who started it (PKCE verifier sealed).
create table oauth_states (
  id              text primary key,
  tenant_id       uuid not null references tenants (id) on delete cascade,
  user_id         uuid not null references users (id) on delete cascade,
  purpose         text not null check (purpose in ('drive')),
  verifier_sealed text not null,
  return_url      text not null check (char_length(return_url) <= 500),
  folder_name     text check (folder_name is null or char_length(folder_name) <= 120),
  keep_local      boolean not null,
  created_at      timestamptz not null default now()
);
