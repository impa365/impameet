## IMPA Meet 1.10.2 — API pública, MCP e docs Developers

Imagens: `impa365/impameet-{platform,agent,screen}` nas tags `1.10.2` e `latest`.

Esta versão consolida a linha 1.10: a API pública, o MCP, as chaves pessoais e a documentação
para desenvolvedores, com as correções de docs e de OpenAPI feitas na 1.10.1 e na 1.10.2.

### API pública

- **Chaves pessoais `impa_…`**, ligadas à pessoa (e-mail), não a uma organização. A mesma chave
  funciona em todas as organizações em que aquele e-mail tem acesso.
- **`X-Impa-Org: <tenant-uuid>`** escolhe a organização da chamada.
- **Escopos** iguais às permissões da organização; a chave só restringe o papel, nunca amplia.
- **REST `/api/v1`**: conta (`me`, `me/orgs`), salas, reuniões, agentes e bases de conhecimento.
- Auditoria de uso, `last_used_at`, expiração e revogação.
- Migration `0035_user_api_keys`.

### MCP

- **Streamable HTTP** em `POST /api/mcp`, JSON-RPC 2.0, com as mesmas chaves e permissões.
- Ferramentas para listar organizações, salas, reuniões, agentes e bases; criar salas, agendar
  reuniões, criar agentes e criar bases.

### Developers

- **`/developers`** no estilo VitePress/ImpaGo, com guia, autenticação, referência, MCP e
  playground Scalar.
- **`/openapi.json`** (OpenAPI 3.1), **`/llms.txt`** e **`/llms-full.txt`** para agentes de IA.
- Correção do `servers` do OpenAPI atrás do Traefik (usa `X-Forwarded-Host`/`X-Forwarded-Proto`).
- Card de **Chaves de API** em **Minha conta**.

### Correções da linha 1.10

- **1.10.1:** docs Developers refeitas no padrão ImpaGo e playground Scalar funcionando.
- **1.10.2:** origem pública correta no OpenAPI quando a plataforma está atrás de proxy.

### Publicação

Antes de criar o release, publique as imagens a partir de uma máquina com Docker logado na
conta `impa365`:

```bash
docker login -u impa365
APPS="platform agent screen" bash deploy/scripts/release.sh 1.10.2
git tag -a v1.10.2 -m "IMPA Meet 1.10.2"
git push origin v1.10.2
```

> As imagens `agent` e `screen` da 1.10.2 são as mesmas da 1.9.3 (a linha 1.10 mudou apenas a
> plataforma); o script de release as reconstrói e publica com a tag nova.

---

## English

### IMPA Meet 1.10.2 — Public API, MCP and Developer docs

Images: `impa365/impameet-{platform,agent,screen}` under `1.10.2` and `latest`.

This release consolidates the 1.10 line: the public API, MCP, personal keys and the developer
documentation, including the docs and OpenAPI fixes from 1.10.1 and 1.10.2.

#### Public API

- **Personal keys `impa_…`**, tied to the person (e-mail), not to an organization. The same key
  works in every organization that e-mail belongs to.
- **`X-Impa-Org: <tenant-uuid>`** selects the organization for the call.
- **Scopes** match the organization permissions; a key can only narrow the role, never widen it.
- **REST `/api/v1`**: account (`me`, `me/orgs`), rooms, meetings, agents and knowledge bases.
- Usage audit, `last_used_at`, expiry and revocation.
- Migration `0035_user_api_keys`.

#### MCP

- **Streamable HTTP** at `POST /api/mcp`, JSON-RPC 2.0, with the same keys and permissions.
- Tools to list organizations, rooms, meetings, agents and bases; create rooms, schedule
  meetings, create agents and create bases.

#### Developers

- **`/developers`** in the VitePress/ImpaGo style, with a guide, authentication, reference, MCP
  and a Scalar playground.
- **`/openapi.json`** (OpenAPI 3.1), **`/llms.txt`** and **`/llms-full.txt`** for AI agents.
- Fixed the OpenAPI `servers` URL behind Traefik (uses `X-Forwarded-Host`/`X-Forwarded-Proto`).
- **API keys** card in **My account**.

#### 1.10 fixes

- **1.10.1:** Developers docs rebuilt in the ImpaGo style and Scalar playground fixed.
- **1.10.2:** correct public origin in OpenAPI when the platform runs behind a proxy.

#### Publishing

Before creating the release, publish the images from a machine with Docker logged in to the
`impa365` account:

```bash
docker login -u impa365
APPS="platform agent screen" bash deploy/scripts/release.sh 1.10.2
git tag -a v1.10.2 -m "IMPA Meet 1.10.2"
git push origin v1.10.2
```

> The 1.10.2 `agent` and `screen` images are the same as 1.9.3 (the 1.10 line only changed the
> platform); the release script rebuilds and publishes them under the new tag.

---

## Español

### IMPA Meet 1.10.2 — API pública, MCP y docs para desarrolladores

Imágenes: `impa365/impameet-{platform,agent,screen}` en las etiquetas `1.10.2` y `latest`.

Esta versión consolida la línea 1.10: la API pública, el MCP, las claves personales y la
documentación para desarrolladores, con las correcciones de docs y OpenAPI de 1.10.1 y 1.10.2.

#### API pública

- **Claves personales `impa_…`**, ligadas a la persona (correo), no a una organización. La misma
  clave funciona en todas las organizaciones a las que pertenece ese correo.
- **`X-Impa-Org: <tenant-uuid>`** elige la organización de la llamada.
- **Alcances** iguales a los permisos de la organización; la clave solo restringe el rol, nunca
  lo amplía.
- **REST `/api/v1`**: cuenta (`me`, `me/orgs`), salas, reuniones, agentes y bases de conocimiento.
- Auditoría de uso, `last_used_at`, expiración y revocación.
- Migración `0035_user_api_keys`.

#### MCP

- **Streamable HTTP** en `POST /api/mcp`, JSON-RPC 2.0, con las mismas claves y permisos.
- Herramientas para listar organizaciones, salas, reuniones, agentes y bases; crear salas,
  agendar reuniones, crear agentes y crear bases.

#### Developers

- **`/developers`** al estilo VitePress/ImpaGo, con guía, autenticación, referencia, MCP y
  playground Scalar.
- **`/openapi.json`** (OpenAPI 3.1), **`/llms.txt`** y **`/llms-full.txt`** para agentes de IA.
- Corrección del `servers` de OpenAPI detrás de Traefik (usa `X-Forwarded-Host`/`X-Forwarded-Proto`).
- Tarjeta de **Claves de API** en **Mi cuenta**.

#### Correcciones de la línea 1.10

- **1.10.1:** docs Developers rehechas al estilo ImpaGo y playground Scalar funcionando.
- **1.10.2:** origen público correcto en OpenAPI cuando la plataforma está detrás de un proxy.

#### Publicación

Antes de crear el release, publica las imágenes desde una máquina con Docker conectado a la
cuenta `impa365`:

```bash
docker login -u impa365
APPS="platform agent screen" bash deploy/scripts/release.sh 1.10.2
git tag -a v1.10.2 -m "IMPA Meet 1.10.2"
git push origin v1.10.2
```

> Las imágenes `agent` y `screen` de 1.10.2 son las mismas de 1.9.3 (la línea 1.10 solo cambió la
> plataforma); el script de release las reconstruye y publica con la etiqueta nueva.
