## IMPA Meet 1.10.0 — API pública, MCP e docs Developers

Imagens: `impa365/impameet-{platform,agent,screen}` nas tags `1.10.0` e `latest`.

### API + MCP
- Chaves pessoais `impa_…` (por e-mail, multi-org via `X-Impa-Org`).
- REST `/api/v1` — me, orgs, rooms, meetings, agents, knowledge-bases.
- MCP Streamable HTTP em `/api/mcp` (mesmas chaves e tools).
- Migration `0035_user_api_keys`.

### Developers (estilo ImpaGo)
- `/developers` — landing + playground Scalar.
- `/openapi.json`, `/llms.txt`, `/llms-full.txt`.
- Card de chaves em **Minha conta**.

---

## English

### API + MCP
- Personal `impa_…` keys; org via `X-Impa-Org` UUID.
- REST `/api/v1` and MCP at `/api/mcp`.

### Developers
- Scalar playground, OpenAPI, llms.txt for agents.
