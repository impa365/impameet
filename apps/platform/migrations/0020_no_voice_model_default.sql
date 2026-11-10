-- The voice model is chosen in each agent, together with its voice provider; the server presets
-- nothing. Agents that never chose a voice provider only carried the old preset.
alter table agents alter column tts_model drop default;
alter table agents alter column tts_model drop not null;
update agents set tts_model = null where tts_integration_id is null;

-- A Fish Audio integration is only a key: the voice model belongs to the agent.
update integrations set default_model = null where kind = 'fish';
