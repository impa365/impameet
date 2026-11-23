import 'server-only';

/** Compact index for AI agents (llms.txt convention). */
export function buildLlmsTxt(origin: string): string {
  return `# IMPA Meet — Documentation Index

> Video meetings, studios, AI agents and knowledge bases. Public REST + MCP.

## Agent workflow
1. Read this index
2. Fetch /llms-full.txt for the full guide, or /openapi.json for the machine schema
3. Create a personal API key in the product (Minha conta → Chaves de API)
4. GET ${origin}/api/v1/me to discover org UUIDs
5. Call REST with Authorization: Bearer impa_… and X-Impa-Org: <uuid>
6. Or connect MCP at ${origin}/api/mcp with the same Bearer key

## Human docs
- ${origin}/developers — Beautiful docs + Scalar playground
- ${origin}/openapi.json — OpenAPI 3.1
- ${origin}/llms-full.txt — Full text guide for LLMs

## Auth
- Header: Authorization: Bearer impa_<secret>
- Org context: X-Impa-Org: <tenant-uuid> (required on tenant routes)
- Keys belong to the person (email), not a single org
- Empty scopes = all role permissions; otherwise role ∩ scopes

## REST
- GET  /api/v1/me
- GET  /api/v1/me/orgs
- GET|POST /api/v1/rooms
- GET|PATCH|DELETE /api/v1/rooms/{slug}
- GET|POST /api/v1/meetings
- GET|POST /api/v1/agents
- PATCH|DELETE /api/v1/agents/{id}
- GET|POST /api/v1/knowledge-bases

## MCP tools
- list_orgs
- list_rooms, create_room
- list_meetings, schedule_meeting
- list_agents, create_agent
- list_knowledge_bases, create_knowledge_base

Pass orgId in tool arguments (or X-Impa-Org header).
`;
}

/** Long-form guide for agents that want everything in one fetch. */
export function buildLlmsFullTxt(origin: string): string {
  return `${buildLlmsTxt(origin)}

## Quickstart (curl)

\`\`\`bash
KEY=impa_…
ORG=$(curl -s -H "Authorization: Bearer $KEY" ${origin}/api/v1/me | jq -r '.orgs[0].id')

curl -s -H "Authorization: Bearer $KEY" -H "X-Impa-Org: $ORG" \\
  ${origin}/api/v1/rooms

curl -s -X POST -H "Authorization: Bearer $KEY" -H "X-Impa-Org: $ORG" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"Sala API","studio":false}' \\
  ${origin}/api/v1/rooms
\`\`\`

## MCP (Cursor / Claude)

\`\`\`json
{
  "mcpServers": {
    "impameet": {
      "url": "${origin}/api/mcp",
      "headers": {
        "Authorization": "Bearer impa_…"
      }
    }
  }
}
\`\`\`

For tenant tools, also send header X-Impa-Org or pass orgId in arguments.

## Permissions (org roles)
admin — all org permissions
manager — panel.access, users.view, users.manage, rooms.manage_all, live.manage
member — none by default (still owns their own rooms when created)

Write agents → agents.manage
Write knowledge → knowledge.manage

## Errors
JSON body: { "error": { "code": string, "message": string } }
Typical status: 400, 401, 403, 404, 409, 429, 500

## Session key management (browser cookie, not Bearer)
GET/POST /api/account/api-keys
DELETE /api/account/api-keys/{id}
`;
}
