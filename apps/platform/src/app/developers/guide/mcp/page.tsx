import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { DocsShell } from '@/components/developers/DocsShell';
import { docsBrand } from '@/server/api-v1/docs-brand';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'MCP · Developers' };

async function origin(): Promise<string> {
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host');
  const proto = h.get('x-forwarded-proto') ?? 'https';
  return host ? `${proto}://${host}` : 'https://seu-dominio';
}

export default async function McpGuidePage() {
  const brand = await docsBrand();
  const base = await origin();

  return (
    <DocsShell brand={brand} active="/developers/guide/mcp">
      <article className="ig-doc">
        <h1>MCP para Agentes de IA</h1>
        <p>
          {brand} expõe MCP <strong>nativo na API</strong> em <code>/api/mcp</code> — sem processo separado
          nem porta extra.
        </p>

        <h2>HTTP na API (recomendado)</h2>
        <pre>{`{
  "mcpServers": {
    "impameet": {
      "url": "${base}/api/mcp",
      "headers": {
        "Authorization": "Bearer impa_…"
      }
    }
  }
}`}</pre>

        <h2>Auth</h2>
        <table>
          <thead>
            <tr>
              <th>Tipo</th>
              <th>Uso</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                Bearer <code>impa_…</code>
              </td>
              <td>Todas as tools</td>
            </tr>
            <tr>
              <td>
                <code>orgId</code> / <code>X-Impa-Org</code>
              </td>
              <td>Tools de tenant (salas, reuniões, agentes…)</td>
            </tr>
          </tbody>
        </table>

        <h2>Tools</h2>
        <ul>
          <li>
            <code>list_orgs</code>
          </li>
          <li>
            <code>list_rooms</code>, <code>create_room</code>
          </li>
          <li>
            <code>list_meetings</code>, <code>schedule_meeting</code>
          </li>
          <li>
            <code>list_agents</code>, <code>create_agent</code>
          </li>
          <li>
            <code>list_knowledge_bases</code>, <code>create_knowledge_base</code>
          </li>
        </ul>

        <h2>llms.txt</h2>
        <p>Índice para agentes:</p>
        <ul>
          <li>
            <a href="/llms.txt" target="_blank" rel="noreferrer">
              /llms.txt
            </a>{' '}
            — índice curto
          </li>
          <li>
            <a href="/llms-full.txt" target="_blank" rel="noreferrer">
              /llms-full.txt
            </a>{' '}
            — guia completo
          </li>
          <li>
            <a href="/openapi.json" target="_blank" rel="noreferrer">
              /openapi.json
            </a>{' '}
            — schema máquina
          </li>
        </ul>
      </article>
    </DocsShell>
  );
}
