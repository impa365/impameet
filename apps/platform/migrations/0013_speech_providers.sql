-- Speech providers: Deepgram and ElevenLabs join Fish Audio, and each agent picks its speaking
-- (TTS) and listening (STT) integrations separately, in any combination.
alter table integrations drop constraint integrations_kind_check;
alter table integrations add constraint integrations_kind_check
  check (kind in ('llm', 'fish', 'deepgram', 'elevenlabs'));

alter table agents
  add column tts_integration_id uuid references integrations(id) on delete set null,
  add column stt_integration_id uuid references integrations(id) on delete set null;

update agents set tts_integration_id = fish_integration_id, stt_integration_id = fish_integration_id
where fish_integration_id is not null;

alter table agents drop column fish_integration_id;
