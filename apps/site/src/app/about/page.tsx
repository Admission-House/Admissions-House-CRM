import type { Metadata } from 'next';
import Link from 'next/link';
import { SITE } from '@/lib/site';

export const metadata: Metadata = {
  title: 'About',
  description: `${SITE.company} helps students choose colleges, and built ${SITE.name} to run that work well.`,
  alternates: { canonical: '/about' },
};

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 pt-14">
      <h1 className="text-4xl font-extrabold text-brand">About {SITE.company}</h1>
      <div className="mt-6 space-y-4 text-lg text-muted">
        <p>{SITE.company} guides students to the right college and course. Doing that well means answering every enquiry quickly, calling at the right time and never losing track of a student.</p>
        <p>{SITE.name} is the system we built to do exactly that. It grew from the daily work of an admission team, so it covers what counsellors and managers actually need: leads, calls, follow-ups, attendance, leave and salary.</p>
        <p>We set it up for your company, with your branches, roles and lead sources, and we stay available when your team has questions.</p>
      </div>
      <div className="mt-10"><Link href="/contact" className="btn btn-ghost">Contact us</Link></div>
    </div>
  );
}
