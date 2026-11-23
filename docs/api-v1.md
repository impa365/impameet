# IMPA Meet — API pública (`/api/v1`) e MCP

**Docs ao vivo (estilo ImpaGo):** [`/developers`](../apps/platform/src/app/developers) no produto — playground Scalar, OpenAPI e `llms.txt`.

| Recurso | URL |
|---------|-----|
| Developers + Scalar | `/developers` |
| OpenAPI 3.1 | `/openapi.json` |
| Índice para IAs | `/llms.txt` |
| Guia completo para IAs | `/llms-full.txt` |
| MCP | `POST /api/mcp` |

Chaves pessoais (`impa_…`) autenticam máquinas e agentes. A chave segue a **pessoa** (e-mail), não uma única org: o header **`X-Impa-Org: <tenant-uuid>`** escolhe em qual organização agir.

## Criar chave

1. Entre → **Minha conta** → **Chaves de API**.
2. Copie o segredo uma vez.
3. Escopos vazios = todos os poderes do papel; se definidos, vale `papel ∩ escopos`.

Sessão (cookie + CSRF):

- `GET /api/account/api-keys`
- `POST /api/account/api-keys` — `{ "name", "scopes?", "expiresAt?" }`
- `DELETE /api/account/api-keys/:id`

## Auth nas rotas públicas

```
Authorization: Bearer impa_…
X-Impa-Org: <tenant-uuid>
```

`GET /api/v1/me` e `GET /api/v1/me/orgs` não exigem `X-Impa-Org`.

## REST

| Método | Path | Notas |
|--------|------|--------|
| GET | `/api/v1/me` | E-mail, key id, escopos, orgs |
| GET | `/api/v1/me/orgs` | Só memberships |
| GET/POST | `/api/v1/rooms` | Listar / criar |
| GET/PATCH/DELETE | `/api/v1/rooms/:slug` | |
| GET/POST | `/api/v1/meetings` | Listar / agendar |
| GET/POST | `/api/v1/agents` | Criar exige `agents.manage` |
| PATCH/DELETE | `/api/v1/agents/:id` | `agents.manage` |
| GET/POST | `/api/v1/knowledge-bases` | Criar exige `knowledge.manage` |

Erros: `{ "error": { "code", "message" } }`.

## MCP

`POST /api/mcp` — JSON-RPC 2.0, mesma chave. Passe `orgId` nos argumentos (ou `X-Impa-Org`).

Tools: `list_orgs`, `list_rooms`, `create_room`, `list_meetings`, `schedule_meeting`, `list_agents`, `create_agent`, `list_knowledge_bases`, `create_knowledge_base`.

## Exemplo

```bash
ORG=$(curl -s -H "Authorization: Bearer $KEY" https://meet.example/api/v1/me \
  | jq -r '.orgs[0].id')

curl -s -H "Authorization: Bearer $KEY" -H "X-Impa-Org: $ORG" \
  https://meet.example/api/v1/rooms
```
