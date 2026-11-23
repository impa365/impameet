'use client';

import { useEffect, useRef } from 'react';

declare global {
  interface Window {
    Scalar?: {
      createApiReference: (
        target: string | HTMLElement,
        config: Record<string, unknown>,
      ) => { mount?: (el: string | HTMLElement) => void };
    };
  }
}

function loadScalarCdn(): Promise<void> {
  if (window.Scalar?.createApiReference) return Promise.resolve();
  const existing = document.getElementById('scalar-cdn') as HTMLScriptElement | null;
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('Scalar CDN failed')), {
        once: true,
      });
      if (window.Scalar?.createApiReference) resolve();
    });
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.id = 'scalar-cdn';
    script.src = 'https://cdn.jsdelivr.net/npm/@scalar/api-reference';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Scalar CDN failed'));
    document.head.appendChild(script);
  });
}

/** Scalar playground — same CDN approach as ImpaGo, with the current JS API. */
export function ScalarPlayground({ openApiUrl }: { openApiUrl: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el || el.dataset.ready === '1') return;
    el.dataset.ready = '1';
    let cancelled = false;

    void (async () => {
      try {
        await loadScalarCdn();
        if (cancelled || !host.current || !window.Scalar?.createApiReference) return;
        host.current.replaceChildren();
        window.Scalar.createApiReference(host.current, {
          url: openApiUrl,
          theme: 'kepler',
          darkMode: true,
          layout: 'modern',
          hideModels: false,
          defaultOpenAllTags: true,
          metaData: { title: 'IMPA Meet API' },
        });
      } catch (err) {
        if (!host.current) return;
        host.current.textContent =
          err instanceof Error ? err.message : 'Não foi possível carregar o playground.';
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [openApiUrl]);

  return <div ref={host} className="dev-scalar" id="scalar-playground" />;
}
