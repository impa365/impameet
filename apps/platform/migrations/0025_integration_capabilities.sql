-- One OpenAI-compatible integration may serve chat, embeddings and reranking: what it proved it
-- can do is recorded by "Testar conexão", and each use still picks its own model explicitly.
alter table integrations
  add column capabilities text[] not null default '{}'
  check (capabilities <@ array['chat', 'embeddings', 'rerank']::text[]);

update integrations set capabilities = array['chat'] where kind = 'llm' and last_test_ok;
update integrations set capabilities = array['embeddings'] where kind = 'embedding' and last_test_ok;
update integrations set capabilities = array['rerank'] where kind = 'rerank' and last_test_ok;

-- The reranking model is the base's choice, like its embedding model (kept from the integration).
alter table knowledge_bases
  add column rerank_model text check (rerank_model is null or char_length(rerank_model) between 1 and 120);

update knowledge_bases b set rerank_model = i.default_model
from integrations i where i.id = b.rerank_integration_id;
