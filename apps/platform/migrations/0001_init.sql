-- IMPA Meet: multi-tenant core (tenants, domains, branding, users, sessions, rooms, audit).

create table tenants (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique
              check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$'),
  name        text not null check (char_length(name) between 1 and 80),
  status      text not null default 'active' check (status in ('active', 'suspended')),
  plan        text not null default 'free',
  limits      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create table tenant_domains (
  hostname            text primary key check (hostname = lower(hostname)),
  tenant_id           uuid not null references tenants (id) on delete cascade,
  verification_token  text not null,
  verified_at         timestamptz,
  created_at          timestamptz not null default now()
);
create index tenant_domains_tenant on tenant_domains (tenant_id);

create table tenant_branding (
  tenant_id      uuid primary key references tenants (id) on delete cascade,
  product_name   text not null check (char_length(product_name) between 1 and 60),
  primary_color  text not null default '#246fe5' check (primary_color ~ '^#[0-9a-f]{6}$'),
  logo_url       text check (logo_url is null or logo_url ~ '^https://'),
  updated_at     timestamptz not null default now()
);

create table users (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants (id) on delete cascade,
  email           text not null check (email = lower(email) and char_length(email) <= 254),
  name            text not null check (char_length(name) between 1 and 80),
  password_hash   text not null,
  role            text not null check (role in ('admin', 'manager', 'member')),
  is_superadmin   boolean not null default false,
  status          text not null default 'active' check (status in ('active', 'disabled')),
  created_at      timestamptz not null default now(),
  last_login_at   timestamptz,
  unique (tenant_id, email)
);

create table sessions (
  id_hash       bytea primary key,
  user_id       uuid not null references users (id) on delete cascade,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  last_seen_at  timestamptz not null default now(),
  ip            text,
  user_agent    text
);
create index sessions_user on sessions (user_id);
create index sessions_expiry on sessions (expires_at);

create table rooms (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants (id) on delete cascade,
  owner_id          uuid references users (id) on delete set null,
  slug              text not null check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'),
  name              text not null check (char_length(name) between 1 and 80),
  password_hash     text,
  allow_guests      boolean not null default true,
  lobby_enabled     boolean not null default false,
  agent_enabled     boolean not null default false,
  max_participants  integer check (max_participants between 2 and 1000),
  created_at        timestamptz not null default now(),
  unique (tenant_id, slug)
);
create index rooms_owner on rooms (owner_id);

create table audit_log (
  id          bigserial primary key,
  tenant_id   uuid references tenants (id) on delete cascade,
  actor_id    uuid references users (id) on delete set null,
  action      text not null,
  target      text,
  meta        jsonb not null default '{}'::jsonb,
  ip          text,
  created_at  timestamptz not null default now()
);
create index audit_log_tenant_time on audit_log (tenant_id, created_at desc);
