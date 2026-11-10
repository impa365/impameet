'use client';

import { useEffect, useState } from 'react';
import { Icon } from './ui/Icon';

/**
 * On narrow screens the side navigation is a drawer: this button opens it, and Escape, the
 * backdrop or choosing a link closes it. Wide screens never show the button.
 */
export function NavDrawerToggle({ openLabel, closeLabel }: { openLabel: string; closeLabel: string }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const shell = document.querySelector('.shell');
    const nav = document.getElementById('shell-nav');
    shell?.toggleAttribute('data-nav-open', open);
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest('a')) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    nav?.addEventListener('click', onClick);
    nav?.querySelector<HTMLElement>('a')?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      nav?.removeEventListener('click', onClick);
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="icon-btn nav-toggle"
        aria-expanded={open}
        aria-controls="shell-nav"
        aria-label={open ? closeLabel : openLabel}
        onClick={() => setOpen(!open)}
      >
        <Icon name={open ? 'close' : 'menu'} />
      </button>
      {open && <div className="nav-backdrop" aria-hidden onClick={() => setOpen(false)} />}
    </>
  );
}
