-- Who enters without asking, as in Google Meet:
--   open        anyone with the link
--   trusted     members of the organization; guests ask to join
--   restricted  only people on the room's invite list; everyone else asks
-- Room owners, admins and managers always enter. Supersedes lobby_enabled (kept, no longer read).
alter table rooms
  add column access text not null default 'trusted'
  check (access in ('open', 'trusted', 'restricted'));

update rooms set access = case when lobby_enabled then 'restricted' else 'trusted' end;

-- Who may draw on the whiteboard and who may create polls (voting stays open to everyone).
alter table rooms
  add column board_policy text not null default 'everyone'
    check (board_policy in ('everyone', 'moderators')),
  add column polls_policy text not null default 'everyone'
    check (polls_policy in ('everyone', 'moderators'));

create table room_invites (
  room_id uuid not null references rooms (id) on delete cascade,
  email text not null check (email = lower(email) and char_length(email) between 3 and 254),
  created_at timestamptz not null default now(),
  primary key (room_id, email)
);
