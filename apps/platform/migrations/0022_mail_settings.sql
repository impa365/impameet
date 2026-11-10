-- E-mail: the platform's SMTP server (super admin) and each organization's choice.
-- Passwords are sealed (AES-256-GCM) and bound to their row.

create table platform_smtp (
  id                boolean primary key default true check (id),
  host              text not null check (char_length(host) between 1 and 253),
  port              integer not null check (port between 1 and 65535),
  security          text not null check (security in ('tls', 'starttls', 'none')),
  username          text not null default '' check (char_length(username) <= 254),
  password_sealed   text,
  from_email        text not null check (char_length(from_email) between 3 and 254),
  from_name         text not null default '' check (char_length(from_name) <= 80),
  reply_to          text check (char_length(reply_to) <= 254),
  offer_to_tenants  boolean not null default true,
  last_test_at      timestamptz,
  last_test_ok      boolean,
  last_test_error   text,
  updated_by        uuid references users (id) on delete set null,
  updated_at        timestamptz not null default now()
);

create table tenant_smtp (
  tenant_id         uuid primary key references tenants (id) on delete cascade,
  mode              text not null check (mode in ('platform', 'custom', 'off')),
  host              text check (char_length(host) between 1 and 253),
  port              integer check (port between 1 and 65535),
  security          text check (security in ('tls', 'starttls', 'none')),
  username          text not null default '' check (char_length(username) <= 254),
  password_sealed   text,
  from_email        text check (char_length(from_email) between 3 and 254),
  from_name         text not null default '' check (char_length(from_name) <= 80),
  reply_to          text check (char_length(reply_to) <= 254),
  last_test_at      timestamptz,
  last_test_ok      boolean,
  last_test_error   text,
  updated_by        uuid references users (id) on delete set null,
  updated_at        timestamptz not null default now(),
  check (mode <> 'custom' or (host is not null and port is not null and security is not null
                              and from_email is not null))
);
