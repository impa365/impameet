import type { Metadata } from 'next';
import { DocsShell } from '@/components/developers/DocsShell';
import { docsBrand } from '@/server/api-v1/docs-brand';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Autenticação · Developers' };

export default async function AuthenticationPage() {
  const brand = await docsBrand();
  return (
    <DocsShell brand={brand} active="/developers/guide/authentication">
      <article className="ig-doc">
        <h1>Autenticação</h1>
        <p>Toda chamada pública usa Bearer. Rotas de tenant também exigem o UUID da organização.</p>

        <h2>Headers</h2>
        <pre>{`Authorization: Bearer impa_…
X-Impa-Org: 00000000-0000-0000-0000-000000000000`}</pre>

        <h2>Chave pessoal</h2>
        <ul>
          <li>
            Prefixo <code>impa_</code>, hash SHA-256 no banco (o segredo não é armazenado)
          </li>
          <li>Pertence à pessoa (e-mail), não a uma única org</li>
          <li>Revogável a qualquer momento em Minha conta</li>
          <li>Opcionalmente com expiração e escopos</li>
        </ul>

        <h2>Escopos</h2>
        <table>
          <thead>
            <tr>
              <th>Escopos</th>
              <th>Efeito</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Vazio / omitido</td>
              <td>Todos os poderes do papel na org</td>
            </tr>
            <tr>
              <td>
                Lista (ex.: <code>rooms.manage_all</code>)
              </td>
              <td>
                Interseção <code>papel ∩ escopos</code>
              </td>
            </tr>
          </tbody>
        </table>

        <h2>Erros comuns</h2>
        <table>
          <thead>
            <tr>
              <th>HTTP</th>
              <th>Significado</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>401</td>
              <td>Chave ausente, inválida ou revogada</td>
            </tr>
            <tr>
              <td>403</td>
              <td>E-mail sem membership na org, ou sem permissão</td>
            </tr>
            <tr>
              <td>400</td>
              <td>
                <code>X-Impa-Org</code> ausente ou não é UUID
              </td>
            </tr>
          </tbody>
        </table>

        <h2>Sessão (browser)</h2>
        <p>Gerenciar chaves com cookie da sessão (CSRF):</p>
        <ul>
          <li>
            <code>GET /api/account/api-keys</code>
          </li>
          <li>
            <code>POST /api/account/api-keys</code>
          </li>
          <li>
            <code>DELETE /api/account/api-keys/:id</code>
          </li>
        </ul>
      </article>
    </DocsShell>
  );
}
