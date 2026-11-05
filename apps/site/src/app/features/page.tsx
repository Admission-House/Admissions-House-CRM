import type { Metadata } from 'next';
import Link from 'next/link';
import { FEATURE_GROUPS } from '@/lib/content';

export const metadata: Metadata = {
  title: 'Features',
  description: 'Lead management, calling, follow-ups, attendance, leave and payroll for admission teams.',
  alternates: { canonical: '/features' },
};

export default function FeaturesPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 pt-14">
      <h1 className="text-4xl font-extrabold text-brand">Features</h1>
      <p className="mt-3 max-w-2xl text-lg text-muted">Everything an admission team uses in a day, in one product.</p>
      {FEATURE_GROUPS.map((g) => (
        <section key={g.heading} className="mt-14" aria-labelledby={`g-${g.heading}`}>
          <h2 id={`g-${g.heading}`} className="text-2xl font-bold text-brand">{g.heading}</h2>
          <p className="mt-1 text-muted">{g.intro}</p>
          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {g.items.map((f) => (
              <div key={f.title} className="card">
                <h3 className="font-bold text-brand">{f.title}</h3>
                <p className="mt-1 text-sm text-muted">{f.text}</p>
              </div>
            ))}
          </div>
        </section>
      ))}
      <div className="mt-16 text-center">
        <Link href="/demo" className="btn btn-primary">Book a demo</Link>
      </div>
    </div>
  );
}
