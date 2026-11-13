-- "present": the agent writes its own topics on the whiteboard (native text everyone can read,
-- screen readers included). Separate from looking at the board, and off until an admin turns it on.
alter table agents drop constraint agents_perception_check;
alter table agents add constraint agents_perception_check
  check (perception <@ array['board', 'polls', 'screen', 'present']::text[]);
