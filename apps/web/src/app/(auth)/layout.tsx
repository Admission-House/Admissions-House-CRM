import { BrandPanel, BrandStrip } from '@/components/auth/brand-panel';

/** Sign-in and password screens: the logo on one half, the form on the other. */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-2">
      <BrandPanel />
      <main className="min-h-dvh">
        <BrandStrip />
        <section className="flex min-h-[calc(100dvh-8rem)] items-center justify-center px-6 py-12 sm:px-12 lg:min-h-dvh">
          <div className="glass w-full max-w-[500px] rounded-3xl px-7 py-10 sm:px-10 sm:py-12">{children}</div>
        </section>
      </main>
    </div>
  );
}
