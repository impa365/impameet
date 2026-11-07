import Link from 'next/link';
import type { Branding } from '@/server/tenants/repo';

export function Brand({ branding }: { branding: Branding }) {
  return (
    <Link href="/" className="brand">
      {branding.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- tenant logos live on their own hosts
        <img src={branding.logoUrl} alt={branding.productName} />
      ) : (
        <span className="brand-dot" aria-hidden />
      )}
      <span>{branding.productName}</span>
    </Link>
  );
}
