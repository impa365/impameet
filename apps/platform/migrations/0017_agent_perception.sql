-- More an AI agent may be allowed to do, each off until an admin turns it on: switch off
-- someone's camera and start or stop the recording (only when a moderator asks), and look at
-- the whiteboard, the polls and the screens people share. A room's moderators can take all of
-- it away during a meeting (agent_actions).
alter table agents drop constraint agents_moderation_tools_check;
alter table agents add constraint agents_moderation_tools_check
  check (moderation_tools <@ array['remove', 'mute', 'lobby', 'camera', 'record']::text[]);

alter table agents add column perception text[] not null default '{}';
alter table agents add constraint agents_perception_check
  check (perception <@ array['board', 'polls', 'screen']::text[]);

alter table rooms add column agent_actions boolean not null default true;
