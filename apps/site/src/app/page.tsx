import Link from 'next/link';
import { HIGHLIGHTS, STEPS } from '@/lib/content';
import { SITE } from '@/lib/site';

export default function HomePage() {
  return (
    <>
      <section className="mx-auto max-w-6xl px-4 pb-16 pt-16 text-center sm:pt-24">
        <p className="text-sm font-semibold uppercase tracking-wide text-brand-600">For admission and counselling teams</p>
        <h1 className="mx-auto mt-3 max-w-3xl text-4xl font-extrabold leading-tight text-brand sm:text-5xl">
          Every lead, call and counsellor in one CRM
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-lg text-muted">
          {SITE.name} brings your enquiries, calling, follow-ups, attendance and payroll together, so no lead is missed and your team always knows what to do next.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link href="/demo" className="btn btn-primary">Book a demo</Link>
          <Link href="/features" className="btn btn-ghost">See the features</Link>
        </div>
      </section>

      <section aria-labelledby="why" className="mx-auto max-w-6xl px-4">
        <h2 id="why" className="sr-only">Why teams choose {SITE.name}</h2>
        <div className="grid gap-5 sm:grid-cols-3">
          {HIGHLIGHTS.map((h) => (
            <div key={h.title} className="card">
              <h3 className="text-lg font-bold text-brand">{h.title}</h3>
              <p className="mt-2 text-muted">{h.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="how" className="mx-auto mt-20 max-w-6xl px-4">
        <h2 id="how" className="text-center text-3xl font-bold text-brand">Up and running in three steps</h2>
        <ol className="mt-8 grid gap-5 sm:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.title} className="card">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand font-bold text-white">{i + 1}</span>
              <h3 className="mt-3 text-lg font-bold text-brand">{s.title}</h3>
              <p className="mt-1 text-muted">{s.text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="mx-auto mt-20 max-w-4xl px-4">
        <div className="rounded-2xl bg-brand px-6 py-12 text-center text-white">
          <h2 className="text-3xl font-bold">See it with your own data</h2>
          <p className="mx-auto mt-3 max-w-xl text-mint">Tell us about your team and we will show you how the CRM would work for it.</p>
          <Link href="/demo" className="btn mt-6 bg-teal text-brand hover:bg-mint">Book a demo</Link>
        </div>
      </section>
    </>
  );
}
