-- The organization's language for people whose browser asks for none we support.
alter table tenant_branding
  add column default_locale text not null default 'pt-BR' check (default_locale in ('pt-BR', 'en', 'es'));

-- Fish Audio voices are per language: {"pt": "<voice id>", "en": "...", "es": "..."}.
-- The agent answers in the language of whoever spoke, if it has a voice for it.
alter table agents
  add column voices jsonb not null default '{}'::jsonb
  check (jsonb_typeof(voices) = 'object');

update agents set voices = jsonb_build_object('pt', voice_id) where voice_id is not null;

-- Agents use only what was chosen for them: no provider, model or voice from the server.
-- The transcription model becomes a per-agent choice; an agent without its own LLM model
-- takes the one its chosen integration was saved with (made explicit, visible and editable).
alter table agents add column stt_model text check (stt_model is null or char_length(stt_model) <= 60);

update agents a set llm_model = i.default_model
from integrations i
where a.llm_model is null and a.llm_integration_id = i.id and i.default_model is not null;
