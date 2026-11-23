import type { Metadata } from 'next';
import { DocsShell } from '@/components/developers/DocsShell';
import { docsBrand } from '@/server/api-v1/docs-brand';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Visão geral · Developers' };

export default async function IntroductionPage() {
  const brand = await docsBrand();
  return (
    <DocsShell brand={brand} active="/developers/guide/introduction">
      <article className="ig-doc">
        <h1>Visão geral</h1>
        <p>
          {brand} expõe uma API pública para salas, reuniões, agentes e bases de conhecimento. Sistemas, CRMs,
          bots e agentes de IA integram sem abrir o painel.
        </p>
        <p>Você envia uma requisição HTTP — a plataforma cuida do resto.</p>

        <h2>O que você pode fazer</h2>
        <ul>
          <li>Listar organizações e agir com a mesma chave em várias orgs</li>
          <li>Criar e gerenciar salas / studios</li>
          <li>Agendar reuniões com convidados</li>
          <li>Gerenciar agentes de IA e bases de conhecimento</li>
          <li>Conectar agentes via MCP Streamable HTTP</li>
        </ul>

        <h2>Arquitetura da integração</h2>
        <h3>Chave pessoal (Bearer impa_…)</h3>
        <p>
          Token da pessoa, criado em Minha conta. Não é por organização: a chave segue o e-mail em todas as
          memberships ativas.
        </p>
        <h3>Organização (X-Impa-Org)</h3>
        <p>
          UUID do tenant. Obrigatório nas rotas de salas, reuniões, agentes e conhecimento. Liste com{' '}
          <code>GET /api/v1/me</code>.
        </p>
        <h3>Permissões</h3>
        <p>Efetivo = papel na org ∩ escopos da chave. Escopos vazios = todos os poderes do papel.</p>

        <h2>Primeiros passos</h2>
        <ul>
          <li>
            <a href="/developers/guide/quickstart">Início rápido</a>
          </li>
          <li>
            <a href="/developers/guide/authentication">Autenticação</a>
          </li>
          <li>
            <a href="/developers/guide/mcp">MCP para agentes</a>
          </li>
          <li>
            <a href="/developers/api/playground">Playground</a>
          </li>
        </ul>
      </article>
    </DocsShell>
  );
}
