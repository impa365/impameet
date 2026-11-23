import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { DocsShell } from '@/components/developers/DocsShell';
import { docsBrand } from '@/server/api-v1/docs-brand';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Início rápido · Developers' };

async function origin(): Promise<string> {
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host');
  const proto = h.get('x-forwarded-proto') ?? 'https';
  return host ? `${proto}://${host}` : '';
}

export default async function QuickstartPage() {
  const brand = await docsBrand();
  const base = await origin();

  return (
    <DocsShell brand={brand} active="/developers/guide/quickstart">
      <article className="ig-doc">
        <h1>Início rápido</h1>
        <p>Do zero até listar salas em menos de cinco minutos.</p>

        <h2>1. Crie uma chave</h2>
        <ol>
          <li>
            Entre em <a href="/account">Minha conta</a>
          </li>
          <li>Em Chaves de API, crie uma chave e copie o segredo (só aparece uma vez)</li>
        </ol>

        <h2>2. Descubra suas organizações</h2>
        <pre>{`curl -s -H "Authorization: Bearer impa_…" \\
  ${base}/api/v1/me`}</pre>
        <p>
          Guarde o <code>id</code> da org desejada — é o valor de <code>X-Impa-Org</code>.
        </p>

        <h2>3. Liste salas</h2>
        <pre>{`curl -s \\
  -H "Authorization: Bearer impa_…" \\
  -H "X-Impa-Org: <tenant-uuid>" \\
  ${base}/api/v1/rooms`}</pre>

        <h2>4. Crie uma sala</h2>
        <pre>{`curl -s -X POST \\
  -H "Authorization: Bearer impa_…" \\
  -H "X-Impa-Org: <tenant-uuid>" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"Sala API","studio":false}' \\
  ${base}/api/v1/rooms`}</pre>

        <h2>Próximo</h2>
        <ul>
          <li>
            <a href="/developers/guide/authentication">Autenticação e escopos</a>
          </li>
          <li>
            <a href="/developers/api/playground">Playground Scalar</a>
          </li>
          <li>
            <a href="/developers/guide/mcp">Conectar MCP</a>
          </li>
        </ul>
      </article>
    </DocsShell>
  );
}
