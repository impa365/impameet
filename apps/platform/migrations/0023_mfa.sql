-- Two-step verification: an authenticator app (TOTP), passkeys (WebAuthn), a code by e-mail and
-- one-time recovery codes. Secrets are sealed; codes are stored only as hashes.

alter table tenants add column require_mfa boolean not null default false;

create table user_mfa (
  user_id              uuid primary key references users (id) on delete cascade,
  totp_secret_sealed   text,
  totp_enabled_at      timestamptz,
  -- The last 30-second step a code was accepted for: a code works once.
  totp_last_step       bigint not null default 0,
  -- A secret being set up, until a code from the app confirms it.
  totp_pending_sealed  text,
  totp_pending_at      timestamptz,
  email_enabled_at     timestamptz,
  recovery_hashes      bytea[] not null default '{}',
  recovery_created_at  timestamptz,
  updated_at           timestamptz not null default now()
);

create table webauthn_credentials (
  id            text primary key check (char_length(id) between 16 and 1400),
  user_id       uuid not null references users (id) on delete cascade,
  -- Passkeys belong to the address they were made on (a custom domain is another one).
  rp_id         text not null,
  public_key    bytea not null,
  counter       bigint not null default 0,
  transports    text[] not null default '{}',
  device_type   text not null default 'singleDevice',
  backed_up     boolean not null default false,
  name          text not null check (char_length(name) between 1 and 60),
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create index webauthn_credentials_user on webauthn_credentials (user_id);

-- The step between the password and the session (and the ceremonies of the account page).
create table auth_challenges (
  id_hash             bytea primary key,
  user_id             uuid references users (id) on delete cascade,
  purpose             text not null check (purpose in ('login', 'enroll', 'passkey', 'account')),
  webauthn_challenge  text,
  email_code_hash     bytea,
  email_sent_at       timestamptz,
  email_sends         integer not null default 0,
  attempts            integer not null default 0,
  ip                  text,
  created_at          timestamptz not null default now(),
  expires_at          timestamptz not null
);
create index auth_challenges_expiry on auth_challenges (expires_at);
create index auth_challenges_user on auth_challenges (user_id);

-- When this session passed the second step (null: signed in with the password only).
alter table sessions add column mfa_at timestamptz;
alter table sessions add column mfa_method text;
