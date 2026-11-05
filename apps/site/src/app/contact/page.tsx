import type { Metadata } from 'next';
import Link from 'next/link';
import { SITE, whatsappHref } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Contact',
  description: `Call, email or message ${SITE.company}.`,
  alternates: { canonical: '/contact' },
};

export default function ContactPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 pt-14">
      <h1 className="text-4xl font-extrabold text-brand">Contact us</h1>
      <p className="mt-3 text-lg text-muted">{SITE.hours}.</p>
      <dl className="card mt-8 grid gap-4 sm:grid-cols-[8rem_1fr]">
        <dt className="font-semibold text-brand">Phone</dt>
        <dd><a className="underline" href={`tel:${SITE.phone}`}>{SITE.phoneDisplay}</a></dd>
        <dt className="font-semibold text-brand">WhatsApp</dt>
        <dd><a className="underline" href={whatsappHref('Hi, I would like to know more about the CRM.')} rel="noopener">Message us</a></dd>
        <dt className="font-semibold text-brand">Email</dt>
        <dd><a className="underline" href={`mailto:${SITE.email}`}>{SITE.email}</a></dd>
        <dt className="font-semibold text-brand">Address</dt>
        <dd>{SITE.address}</dd>
      </dl>
      <div className="mt-8"><Link href="/demo" className="btn btn-primary">Book a demo</Link></div>
    </div>
  );
}
