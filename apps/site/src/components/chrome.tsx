import Image from 'next/image';
import Link from 'next/link';
import { SITE, whatsappHref } from '@/lib/site';

export const NAV = [
  { href: '/features', label: 'Features' },
  { href: '/about', label: 'About' },
  { href: '/contact', label: 'Contact' },
] as const;

export function Header() {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-white/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3">
        <Link href="/" className="flex items-center gap-2 font-bold text-brand">
          <Image src="/logo-mark.png" alt="" width={32} height={32} priority />
          {SITE.name}
        </Link>
        <nav aria-label="Main" className="flex items-center gap-5 text-sm font-medium">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className="text-muted hover:text-brand">{n.label}</Link>
          ))}
          <Link href="/demo" className="btn btn-primary !py-2 text-sm">Book a demo</Link>
        </nav>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="mt-24 border-t border-line bg-brand text-mint">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:grid-cols-3">
        <div>
          <p className="font-bold text-white">{SITE.name}</p>
          <p className="mt-2 text-sm">By {SITE.company}. {SITE.address}</p>
        </div>
        <nav aria-label="Footer" className="flex flex-col gap-1 text-sm">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className="hover:text-white">{n.label}</Link>
          ))}
          <Link href="/demo" className="hover:text-white">Book a demo</Link>
        </nav>
        <div className="flex flex-col gap-1 text-sm">
          <a href={`mailto:${SITE.email}`} className="hover:text-white">{SITE.email}</a>
          <a href={`tel:${SITE.phone}`} className="hover:text-white">{SITE.phoneDisplay}</a>
          <a href={whatsappHref('Hi, I would like to know more about the CRM.')} className="hover:text-white" rel="noopener">WhatsApp us</a>
          <span>{SITE.hours}</span>
        </div>
      </div>
      <p className="border-t border-white/10 py-4 text-center text-xs">© {new Date().getFullYear()} {SITE.company}. All rights reserved.</p>
    </footer>
  );
}
