import type { Metadata } from 'next';
import { Figtree, Syne } from 'next/font/google';
import { headers } from 'next/headers';
import type { CSSProperties } from 'react';
import { ScalarPlayground } from '@/components/developers/ScalarPlayground';
import { currentTenant } from '@/server/request';
import { DEFAULT_BRANDING } from '@/server/tenants/repo';
import './developers.css';

export const dynamic = 'force-dynamic';

const display = Syne({
  subsets: ['latin'],
  weight: ['600', '700', '800'],
  variable: '--dev-font-display',
  display: 'swap',
});

const body = Figtree({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--dev-font-body',
  display: 'swap',
});

export async function generateMetadata(): Promise<Metadata> {
  const ctx = await currentTenant();
  const name = ctx?.branding.productName ?? DEFAULT_BRANDING.productName;
  return {
    title: `Developers · ${name}`,
    description: `API REST, MCP e playground OpenAPI do ${name}`,
    robots: { index: true },
  };
}

async function originFromRequest(): Promise<string> {
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host');
  const proto = h.get('x-forwarded-proto') ?? 'https';
  if (host) return `${proto}://${host}`;
  return '';
}

export default async function DevelopersPage() {
  const ctx = await currentTenant();
  const brand = ctx?.branding.productName ?? DEFAULT_BRANDING.productName;
  const origin = await originFromRequest();
  const openApiUrl = `${origin}/openapi.json`;

  const accent = ctx?.branding.primaryColor ?? DEFAULT_BRANDING.primaryColor;
  const theme = {
    '--dev-accent': accent,
  } as CSSProperties;

  return (
    <div className={`dev-root ${display.variable} ${body.variable}`} style={theme}>
      <header className="dev-nav">
        <a className="dev-brand" href="/developers">
          <span className="dev-brand-mark" aria-hidden />
          {brand}
          <span style={{ color: 'var(--dev-muted)', fontWeight: 600 }}>Developers</span>
        </a>
        <nav className="dev-nav-links" aria-label="Seções">
          <a href="#guia">Guia</a>
          <a href="#mcp">MCP</a>
          <a href="#playground">Playground</a>
          <a href="/llms.txt" target="_blank" rel="noreferrer">
            llms.txt
          </a>
          <a href="/openapi.json" target="_blank" rel="noreferrer">
            OpenAPI
          </a>
        </nav>
        <a className="dev-nav-cta" href="/account">
          Criar chave
        </a>
      </header>

      <section className="dev-hero">
        <div className="dev-hero-copy">
          <p className="dev-kicker">API · MCP · OpenAPI</p>
          <h1>{brand}</h1>
          <p className="dev-hero-lead">
            Integre salas, reuniões, agentes e bases de conhecimento com uma API REST moderna, playground
            estilo Scalar e índice <code>llms.txt</code> para agentes de IA.
          </p>
          <div className="dev-hero-actions">
            <a className="dev-btn dev-btn-primary" href="#playground">
              Abrir playground
            </a>
            <a className="dev-btn dev-btn-ghost" href="/llms.txt" target="_blank" rel="noreferrer">
              Abrir llms.txt
            </a>
          </div>
        </div>
        <div className="dev-hero-visual" aria-hidden />
      </section>

      <section className="dev-section" id="guia">
        <div className="dev-section-inner">
          <h2>Comece em três passos</h2>
          <p className="dev-lead">
            Chaves são pessoais: uma chave <code>impa_…</code> funciona em todas as organizações do seu
            e-mail. O header <code>X-Impa-Org</code> escolhe qual.
          </p>
          <div className="dev-grid">
            <article className="dev-tile">
              <h3>1. Crie a chave</h3>
              <p>
                Em <a href="/account">Minha conta</a>, gere uma chave e copie o segredo uma única vez.
              </p>
            </article>
            <article className="dev-tile">
              <h3>2. Descubra a org</h3>
              <p>
                <code>GET /api/v1/me</code> devolve os UUIDs. Use um deles em <code>X-Impa-Org</code>.
              </p>
            </article>
            <article className="dev-tile">
              <h3>3. Chame a API</h3>
              <p>
                Bearer + org header. Ou conecte o MCP em <code>/api/mcp</code> com a mesma chave.
              </p>
            </article>
          </div>

          <pre className="dev-code" style={{ marginTop: 24 }}>
            {`curl -s -H "Authorization: Bearer impa_…" ${origin || ''}/api/v1/me

curl -s \\
  -H "Authorization: Bearer impa_…" \\
  -H "X-Impa-Org: <tenant-uuid>" \\
  ${origin || ''}/api/v1/rooms`}
          </pre>
        </div>
      </section>

      <section className="dev-section" id="mcp">
        <div className="dev-section-inner">
          <h2>MCP nativo</h2>
          <p className="dev-lead">
            Sem processo extra. Cursor, Claude e outros agentes falam JSON-RPC no mesmo host — espelhando
            salas, reuniões, agentes e conhecimento.
          </p>
          <pre className="dev-code">{`{
  "mcpServers": {
    "impameet": {
      "url": "${origin || 'https://seu-dominio'}/api/mcp",
      "headers": {
        "Authorization": "Bearer impa_…"
      }
    }
  }
}`}</pre>
          <div className="dev-links" style={{ marginTop: 20 }}>
            <a className="dev-chip" href="/llms.txt" target="_blank" rel="noreferrer">
              /llms.txt
            </a>
            <a className="dev-chip" href="/llms-full.txt" target="_blank" rel="noreferrer">
              /llms-full.txt
            </a>
            <a className="dev-chip" href="/openapi.json" target="_blank" rel="noreferrer">
              /openapi.json
            </a>
            <a className="dev-chip" href="/api/mcp" target="_blank" rel="noreferrer">
              /api/mcp
            </a>
          </div>
        </div>
      </section>

      <section className="dev-section dev-playground" id="playground">
        <div className="dev-section-inner" style={{ maxWidth: 1400 }}>
          <h2>API Playground</h2>
          <p className="dev-lead">
            Explore e teste os endpoints com Scalar — cole a chave Bearer e o UUID da org no canto de
            autenticação.
          </p>
          <ScalarPlayground openApiUrl={openApiUrl || '/openapi.json'} />
        </div>
      </section>

      <footer className="dev-footer">{brand} Developers · OpenAPI 3.1 · MCP Streamable HTTP</footer>
    </div>
  );
}
