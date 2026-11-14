-- Each person may connect their own Google Calendar: meetings they schedule in the platform
-- then show up there, with the room link, and Google invites the guests. Refresh token sealed.
create table user_calendars (
  user_id       uuid primary key references users (id) on delete cascade,
  tenant_id     uuid not null references tenants (id) on delete cascade,
  google_email  text check (google_email is null or char_length(google_email) <= 320),
  secret_sealed text not null,
  created_at    timestamptz not null default now()
);

-- The Google Calendar event of a meeting (in its organizer's calendar), and why it is missing.
alter table meetings
  add column google_event_id text check (google_event_id is null or char_length(google_event_id) <= 1024),
  add column google_user_id  uuid references users (id) on delete set null,
  add column google_error    text;

alter table oauth_states drop constraint oauth_states_purpose_check;
alter table oauth_states add constraint oauth_states_purpose_check
  check (purpose in ('drive', 'youtube', 'calendar'));
