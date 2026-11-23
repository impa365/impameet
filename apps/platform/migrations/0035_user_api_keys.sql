-- Public REST / MCP: API keys belong to a user (not an org). The same person can act
-- in every organization where that email has an active membership; X-Impa-Org picks which.

create table user_api_keys (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users (id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 80),
  -- SHA-256 of the full secret (impa_…). Only the prefix is shown again.
  token_hash    bytea not null unique,
  prefix        text not null check (prefix ~ '^impa_[A-Za-z0-9_-]{8}$'),
  -- Empty = all org permissions the membership grants. Otherwise intersection.
  scopes        text[] not null default '{}',
  last_used_at  timestamptz,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);

create index user_api_keys_user on user_api_keys (user_id) where revoked_at is null;
create index user_api_keys_prefix on user_api_keys (prefix);

create table user_api_key_audit (
  id          bigserial primary key,
  key_id      uuid references user_api_keys (id) on delete set null,
  user_id     uuid references users (id) on delete set null,
  tenant_id   uuid references tenants (id) on delete set null,
  method      text not null,
  path        text not null,
  status      integer not null,
  ip          text,
  created_at  timestamptz not null default now()
);
create index user_api_key_audit_key on user_api_key_audit (key_id, created_at desc);
