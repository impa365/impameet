import type { Metadata } from 'next';
import { DocsShell } from '@/components/developers/DocsShell';
import { ScalarPlayground } from '@/components/developers/ScalarPlayground';
import { docsBrand } from '@/server/api-v1/docs-brand';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'API Playground · Developers' };

export default async function PlaygroundPage() {
  const brand = await docsBrand();
  return (
    <DocsShell brand={brand} active="/developers/api/playground">
      <article className="ig-doc">
        <h1>API Playground</h1>
        <p>Teste os endpoints interativamente.</p>
        <div className="ig-playground-wrap">
          <ScalarPlayground openApiUrl="/openapi.json" />
        </div>

        <h2>Configuração rápida</h2>
        <ol>
          <li>
            Auth: <code>Authorization: Bearer impa_…</code>
          </li>
          <li>
            Header <code>X-Impa-Org</code>: UUID da org (<code>GET /api/v1/me</code>)
          </li>
          <li>Execute qualquer endpoint</li>
        </ol>
        <p>
          OpenAPI:{' '}
          <a href="/openapi.json" target="_blank" rel="noreferrer">
            openapi.json
          </a>
        </p>
      </article>
    </DocsShell>
  );
}
