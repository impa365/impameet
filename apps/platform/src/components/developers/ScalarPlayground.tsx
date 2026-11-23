'use client';

import { useEffect, useRef } from 'react';

/** Scalar API Reference — same idea as ImpaGo playground, themed for IMPA Meet. */
export function ScalarPlayground({ openApiUrl }: { openApiUrl: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el || el.dataset.ready === '1') return;
    el.dataset.ready = '1';

    const boot = () => {
      const config = {
        theme: 'kepler',
        layout: 'modern',
        darkMode: true,
        hideModels: false,
        defaultOpenAllTags: true,
        metaData: {
          title: 'IMPA Meet API',
        },
      };
      const ref = document.createElement('script');
      ref.id = 'api-reference';
      ref.setAttribute('data-url', openApiUrl);
      ref.setAttribute('data-configuration', JSON.stringify(config));
      el.appendChild(ref);
    };

    if (document.getElementById('scalar-cdn')) {
      boot();
      return;
    }
    const script = document.createElement('script');
    script.id = 'scalar-cdn';
    script.src = 'https://cdn.jsdelivr.net/npm/@scalar/api-reference';
    script.async = true;
    script.onload = boot;
    document.head.appendChild(script);
  }, [openApiUrl]);

  return <div ref={host} className="dev-scalar" id="scalar-playground" />;
}
