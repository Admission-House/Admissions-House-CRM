import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { Footer, Header } from '@/components/chrome';
import { SITE } from '@/lib/site';
import './globals.css';

const inter = Inter({ variable: '--font-inter', subsets: ['latin'], display: 'swap' });

const DESCRIPTION = 'A CRM built for admission and counselling teams: every lead, call, follow-up, attendance and payroll in one place.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: { default: `${SITE.name} | Lead, calling and team management for admission teams`, template: `%s | ${SITE.name}` },
  description: DESCRIPTION,
  openGraph: { title: SITE.name, description: DESCRIPTION, siteName: SITE.name, type: 'website', locale: 'en_IN' },
  alternates: { canonical: '/' },
};

export const viewport: Viewport = { themeColor: '#063b39', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:p-2">Skip to content</a>
        <Header />
        <main id="main">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
