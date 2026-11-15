-- Whether the room's meetings are transcribed end-to-end (policy), independent of anyone
-- watching live captions. Default off so existing rooms keep today's opt-in behaviour.
alter table rooms add column auto_transcript boolean not null default false;
