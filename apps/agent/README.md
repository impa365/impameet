# IMPA Meet — agente de voz

Worker que coloca os assistentes de IA nas salas LiveKit do IMPA Meet como participantes.

```
participante ─► LiveKit ─► STT: Fish Audio, Deepgram Flux ou ElevenLabs Scribe (WebSocket)
                              └─► LLM compatível com OpenAI (qualquer modelo)
                                    └─► TTS: Fish Audio, Deepgram Flux/Aura ou ElevenLabs (WebSocket) ─► sala
```

Nada de provedor, modelo ou voz padrão no servidor: cada agente é configurado no painel
(Admin → Agentes de IA) com a sua integração de LLM e o seu modelo, o provedor de voz (TTS) e o
de transcrição (STT), escolhidos separadamente entre Fish Audio, Deepgram e ElevenLabs,
o modelo de transcrição e uma voz por idioma. Um agente incompleto não entra nas reuniões.

## Módulos (`src/meet_impar_agent/`)

| Arquivo | Responsabilidade |
|---|---|
| `config.py` | Configuração do worker (LiveKit, plataforma, tela); segredos de `<NOME>_FILE` |
| `profile.py` | Carrega da plataforma o perfil de cada agente (persona, chaves, modelos, vozes) |
| `languages.py` | Idioma de quem fala e a voz de cada idioma |
| `providers.py` | Provedores de voz e transcrição e como cada um troca de voz |
| `persona.py` | O agente na sala: quem está falando, silêncio, passagem de vez, troca de voz |
| `pipeline.py` | Monta STT, LLM e TTS com as escolhas do agente |
| `captions.py` | Legendas ao vivo da sala |
| `screen.py` | Ferramentas de compartilhamento de tela pela IA |
| `redaction.py` | Remove segredos de qualquer linha de log do processo |
| `telemetry.py` | Latência por turno, sem o conteúdo da conversa |
| `main.py` | Servidor de agentes (despacho explícito pelo `AGENT_NAME`) |

## Configuração do worker

| Variável | Para quê |
|---|---|
| `LIVEKIT_URL`, `LIVEKIT_API_KEY_FILE`, `LIVEKIT_API_SECRET_FILE` | Conexão com o LiveKit (obrigatória) |
| `PLATFORM_URL`, `PLATFORM_TOKEN_FILE` | De onde vêm os perfis dos agentes |
| `SCREEN_URL`, `SCREEN_TOKEN_FILE` | Compartilhamento de tela pela IA (opcional) |
| `AGENT_NAME` | Nome de despacho; igual ao `AGENT_NAME` da plataforma (os dois usam `kaiser` se não definido) |
| `LOG_LEVEL` | Nível de log (`DEBUG`, `INFO`, `WARNING`, `ERROR`) |

O worker só sabe onde se conectar. Provedores, chaves, modelos, vozes, temperatura, tamanho
da resposta, tempo limite, latência da voz e volume do som de digitação são escolhidos em
cada agente no painel e chegam pela plataforma; nada disso tem valor no servidor.

Segredos nunca ficam em arquivo, variável de ambiente ou log: são Docker Swarm secrets
(criptografados em repouso e em trânsito, montados em memória só no container).

## Desenvolvimento

```bash
uv sync
uv run pytest            # testes + cobertura mínima de 90%
uv run ruff check src tests && uv run mypy && uv run bandit -q -r src
```

A imagem roda a mesma bateria no estágio `test` do `Dockerfile`:
`docker build --target test apps/agent`.

## Dependência fixada

`vendor/` contém o LiveKit Agents 1.8.10 + plugins gerados do commit
`livekit/agents@652eee4`, porque o STT em tempo real do Fish Audio ainda não saiu em versão
publicada. Hashes em `vendor/SHA256SUMS` (conferidos no build). Quando sair a versão com
`fishaudio.STT`, troque as fontes `path` do `pyproject.toml` pelas versões do PyPI.
