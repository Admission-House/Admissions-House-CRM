import type { Metadata } from 'next';
import { DemoForm } from '@/components/demo-form';

export const metadata: Metadata = {
  title: 'Book a demo',
  description: 'Tell us about your team and we will show you how the CRM would work for it.',
  alternates: { canonical: '/demo' },
};

export default function DemoPage() {
  return (
    <div className="mx-auto max-w-2xl px-4 pt-14">
      <h1 className="text-4xl font-extrabold text-brand">Book a demo</h1>
      <p className="mt-3 text-lg text-muted">Fill in the form and we will call you to arrange a demo.</p>
      <div className="card mt-8"><DemoForm /></div>
    </div>
  );
}
