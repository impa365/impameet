## IMPA Meet 1.9.2 — Voz e chat separados + saúde do agente

Imagens: `impa365/impameet-{platform,agent,screen}` nas tags `1.9.2` e `latest`.

### Voz ≠ chat (acessibilidade)
- O agente **não espelha mais** o que fala no chat da reunião.
- **Sem mute:** responde em voz; no chat só se pedirem (“manda no chat o link…”) via ferramenta `enviar_no_chat`.
- **Com mute (silêncio):** responde **só no chat**, sem áudio.
- Nunca fala e escreve a mesma resposta ao mesmo tempo — evita ouvir/ler em dobro (leitores de tela).

### Saúde e auditoria do agente
- Admin → Agentes → **Saúde e auditoria**: por que ficou quieto ou falhou (STT / LLM / TTS / só quando chamado / mutado).
- Na sala, o chip da IA mostra o motivo (silêncio, espera o nome, erro de transcrição, etc.).
- Migration `0034_agent_health.sql` (histórico ~14 dias, sem texto da conversa).

---

## English

### Voice ≠ chat
- Spoken answers are no longer mirrored into meeting chat.
- Unmuted: speak; chat only via explicit `enviar_no_chat` when asked.
- Muted: chat-only replies (no audio). Never both at once.

### Agent health
- Admin → Agents → Health and audit trail; room chip shows skip/error reason.
- Requires migration `0034_agent_health.sql`.
