import '@livekit/components-styles';
import './globals.css';
import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import type { CSSProperties, ReactNode } from 'react';
import { I18nProvider } from '@/i18n/client';
import { clientI18n, getLocale } from '@/i18n/server';
import { THEME_COOKIE, parseTheme } from '@/lib/theme';
import { currentTenant } from '@/server/request';
import { DEFAULT_BRANDING } from '@/server/tenants/repo';

export const dynamic = 'force-dynamic';

export const viewport: Viewport = { themeColor: '#202124', width: 'device-width', initialScale: 1 };

export async function generateMetadata(): Promise<Metadata> {
  const ctx = await currentTenant();
  const name = ctx?.branding.productName ?? DEFAULT_BRANDING.productName;
  return { title: { default: name, template: `%s · ${name}` }, robots: { index: false } };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const ctx = await currentTenant();
  const brand = ctx?.branding.primaryColor ?? DEFAULT_BRANDING.primaryColor;
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  const locale = await getLocale();
  return (
    <html lang={locale} data-theme={theme} style={{ '--brand': brand } as CSSProperties}>
      <body>
        <I18nProvider {...clientI18n(locale)}>{children}</I18nProvider>
      </body>
    </html>
  );
}
