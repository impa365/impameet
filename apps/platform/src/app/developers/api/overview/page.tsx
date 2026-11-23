import type { Metadata } from 'next';
import { DocsShell } from '@/components/developers/DocsShell';
import { docsBrand } from '@/server/api-v1/docs-brand';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Referência API · Developers' };

export default async function ApiOverviewPage() {
  const brand = await docsBrand();
  return (
    <DocsShell brand={brand} active="/developers/api/overview">
      <article className="ig-doc">
        <h1>Referência API</h1>
        <p>
          REST em <code>/api/v1</code>. Spec OpenAPI 3.1 em{' '}
          <a href="/openapi.json" target="_blank" rel="noreferrer">
            /openapi.json
          </a>
          . Teste no <a href="/developers/api/playground">Playground</a>.
        </p>

        <h2>Conta</h2>
        <table>
          <thead>
            <tr>
              <th>Método</th>
              <th>Path</th>
              <th>Notas</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>GET</td>
              <td>
                <code>/api/v1/me</code>
              </td>
              <td>E-mail, key id, escopos, orgs (sem X-Impa-Org)</td>
            </tr>
            <tr>
              <td>GET</td>
              <td>
                <code>/api/v1/me/orgs</code>
              </td>
              <td>Só memberships</td>
            </tr>
          </tbody>
        </table>

        <h2>Salas</h2>
        <table>
          <thead>
            <tr>
              <th>Método</th>
              <th>Path</th>
              <th>Notas</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>GET / POST</td>
              <td>
                <code>/api/v1/rooms</code>
              </td>
              <td>Listar / criar</td>
            </tr>
            <tr>
              <td>GET / PATCH / DELETE</td>
              <td>
                <code>/api/v1/rooms/:slug</code>
              </td>
              <td>Detalhe / atualizar / excluir</td>
            </tr>
          </tbody>
        </table>

        <h2>Reuniões</h2>
        <table>
          <thead>
            <tr>
              <th>Método</th>
              <th>Path</th>
              <th>Notas</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>GET / POST</td>
              <td>
                <code>/api/v1/meetings</code>
              </td>
              <td>Listar / agendar</td>
            </tr>
          </tbody>
        </table>

        <h2>Agentes</h2>
        <table>
          <thead>
            <tr>
              <th>Método</th>
              <th>Path</th>
              <th>Notas</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>GET / POST</td>
              <td>
                <code>/api/v1/agents</code>
              </td>
              <td>
                Criar exige <code>agents.manage</code>
              </td>
            </tr>
            <tr>
              <td>PATCH / DELETE</td>
              <td>
                <code>/api/v1/agents/:id</code>
              </td>
              <td>
                <code>agents.manage</code>
              </td>
            </tr>
          </tbody>
        </table>

        <h2>Conhecimento</h2>
        <table>
          <thead>
            <tr>
              <th>Método</th>
              <th>Path</th>
              <th>Notas</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>GET / POST</td>
              <td>
                <code>/api/v1/knowledge-bases</code>
              </td>
              <td>
                Criar exige <code>knowledge.manage</code>
              </td>
            </tr>
          </tbody>
        </table>

        <h2>Erros</h2>
        <pre>{`{ "error": { "code": "forbidden", "message": "…" } }`}</pre>
      </article>
    </DocsShell>
  );
}
