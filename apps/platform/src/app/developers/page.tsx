import type { Metadata } from 'next';
import { currentTenant } from '@/server/request';
import { DEFAULT_BRANDING } from '@/server/tenants/repo';
import '@/components/developers/docs-shell.css';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const ctx = await currentTenant();
  const name = ctx?.branding.productName ?? DEFAULT_BRANDING.productName;
  return {
    title: `${name} · Developers`,
    description: `API REST, MCP e playground OpenAPI do ${name}`,
    robots: { index: true },
  };
}

/** ImpaGo-style VitePress home for IMPA Meet developers. */
export default async function DevelopersHomePage() {
  const ctx = await currentTenant();
  const brand = ctx?.branding.productName ?? DEFAULT_BRANDING.productName;

  return (
    <div className="ig-root">
      <header className="ig-nav">
        <div className="ig-nav-inner">
          <a className="ig-brand" href="/developers">
            <span className="ig-logo" aria-hidden />
            <span>{brand}</span>
          </a>
          <nav className="ig-nav-links" aria-label="Principal">
            <a href="/developers/guide/introduction">Guia</a>
            <a href="/developers/api/overview">API</a>
            <a href="/developers/guide/mcp">MCP</a>
            <a href="/developers/api/playground">Playground</a>
            <a href="/llms.txt" target="_blank" rel="noreferrer">
              llms.txt
            </a>
          </nav>
          <a className="ig-nav-cta" href="/account">
            Criar chave
          </a>
        </div>
      </header>

      <div className="ig-home">
        <section className="ig-hero">
          <h1 className="ig-hero-name">{brand}</h1>
          <p className="ig-hero-text">Meet API open source</p>
          <p className="ig-hero-tag">
            Integre salas, reuniões, agentes e bases de conhecimento com uma API REST moderna, MCP nativo para
            agentes de IA e índice <code>llms.txt</code>.
          </p>
          <div className="ig-hero-actions">
            <a className="ig-btn ig-btn-brand" href="/developers/guide/quickstart">
              Início rápido
            </a>
            <a className="ig-btn ig-btn-alt" href="/developers/api/overview">
              Referência API
            </a>
          </div>
        </section>

        <section className="ig-features">
          <article className="ig-feature">
            <h3>Chaves pessoais</h3>
            <p>
              Uma chave <code>impa_…</code> por pessoa. Vale em todas as orgs do e-mail;{' '}
              <code>X-Impa-Org</code> escolhe qual.
            </p>
          </article>
          <article className="ig-feature">
            <h3>MCP nativo</h3>
            <p>
              Conecte Cursor, Claude e agentes em <code>/api/mcp</code> com as mesmas chaves da REST.
            </p>
          </article>
          <article className="ig-feature">
            <h3>llms.txt</h3>
            <p>
              Índice curto em <code>/llms.txt</code> e guia completo em <code>/llms-full.txt</code> para
              treinar agentes.
            </p>
          </article>
          <article className="ig-feature">
            <h3>Salas e studios</h3>
            <p>Crie e gerencie rooms, agendas e transmissão ao vivo pela API.</p>
          </article>
          <article className="ig-feature">
            <h3>Agentes de IA</h3>
            <p>
              Liste e configure assistentes com RBAC (<code>agents.manage</code>).
            </p>
          </article>
          <article className="ig-feature">
            <h3>Playground Scalar</h3>
            <p>Teste endpoints interativamente com OpenAPI 3.1 — igual ao ImpaGo.</p>
          </article>
        </section>
      </div>

      <footer className="ig-footer">{brand} — documentação · OpenAPI 3.1 · MCP</footer>
    </div>
  );
}
