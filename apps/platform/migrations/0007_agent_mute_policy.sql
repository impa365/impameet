-- Who may tell an agent to stay quiet (and to talk again); 'disabled' turns the feature off.
alter table agents
  add column mute_policy text not null default 'everyone'
  check (mute_policy in ('everyone', 'moderators', 'disabled'));
