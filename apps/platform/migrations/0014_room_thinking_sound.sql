-- Per-room switch for the soft typing sound the AI plays while it prepares an answer.
alter table rooms add column thinking_sound boolean not null default true;
