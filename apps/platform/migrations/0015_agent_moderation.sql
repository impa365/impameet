-- What an AI agent may do to other people in a meeting (off unless an admin turns it on), and
-- the admin's own rules for when it should act without being asked.
alter table agents
  add column moderation_tools text[] not null default '{}',
  add column moderation_rules text not null default '';

alter table agents add constraint agents_moderation_tools_check
  check (moderation_tools <@ array['remove', 'mute', 'lobby']::text[]);
