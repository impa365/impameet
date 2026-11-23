import type { ReactNode } from 'react';
import './docs-shell.css';

export type DocsNavItem = { href: string; label: string };
export type DocsNavGroup = { title: string; items: DocsNavItem[] };

const NAV: DocsNavGroup[] = [
  {
    title: 'Introdução',
    items: [
      { href: '/developers/guide/introduction', label: 'Visão geral' },
      { href: '/developers/guide/quickstart', label: 'Início rápido' },
      { href: '/developers/guide/authentication', label: 'Autenticação' },
      { href: '/developers/guide/mcp', label: 'MCP para Agentes' },
    ],
  },
  {
    title: 'API',
    items: [
      { href: '/developers/api/overview', label: 'Referência' },
      { href: '/developers/api/playground', label: 'Playground' },
    ],
  },
];

/** VitePress-style shell matching ImpaGo docs. */
export function DocsShell({
  brand,
  active,
  children,
}: {
  brand: string;
  active?: string;
  children: ReactNode;
}) {
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

      <div className="ig-body">
        <aside className="ig-sidebar" aria-label="Documentação">
          {NAV.map((group) => (
            <div key={group.title} className="ig-side-group">
              <p className="ig-side-title">{group.title}</p>
              <ul>
                {group.items.map((item) => (
                  <li key={item.href}>
                    <a
                      href={item.href}
                      className={active === item.href ? 'is-active' : undefined}
                      aria-current={active === item.href ? 'page' : undefined}
                    >
                      {item.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div className="ig-side-group">
            <p className="ig-side-title">Máquina</p>
            <ul>
              <li>
                <a href="/openapi.json" target="_blank" rel="noreferrer">
                  openapi.json
                </a>
              </li>
              <li>
                <a href="/llms-full.txt" target="_blank" rel="noreferrer">
                  llms-full.txt
                </a>
              </li>
            </ul>
          </div>
        </aside>
        <main className="ig-main">{children}</main>
      </div>

      <footer className="ig-footer">{brand} — documentação · OpenAPI 3.1 · MCP</footer>
    </div>
  );
}
