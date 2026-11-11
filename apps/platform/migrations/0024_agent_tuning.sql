-- How each agent thinks and sounds, chosen in the agent like its providers and models. These came
-- from the voice worker's environment, the same for every agent; existing agents keep the values
-- they were running with, new agents choose them.
alter table agents
  add column llm_temperature numeric(3, 2) check (llm_temperature between 0 and 2),
  add column llm_max_tokens integer check (llm_max_tokens between 16 and 8192),
  add column llm_timeout_s integer check (llm_timeout_s between 1 and 120),
  add column thinking_volume numeric(3, 2) check (thinking_volume between 0 and 1),
  -- Fish Audio only: its trade-off between how fast the voice starts and how it sounds.
  add column tts_latency text check (tts_latency in ('low', 'balanced', 'normal'));

update agents set llm_temperature = 0.6, llm_max_tokens = 400, llm_timeout_s = 15, thinking_volume = 0.5;
update agents a set tts_latency = 'balanced'
from integrations i where i.id = a.tts_integration_id and i.kind = 'fish';
