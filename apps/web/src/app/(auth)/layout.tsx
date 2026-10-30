import { BrandPanel, BrandStrip } from '@/components/auth/brand-panel';

/** Sign-in and password screens: the logo on one half, the form on the other. */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-2">
      <BrandPanel />
      <main className="min-h-dvh">
        <BrandStrip />
        <section className="flex min-h-[calc(100dvh-8rem)] items-center justify-center bg-[#f6f9f9] px-6 py-12 sm:px-12 lg:min-h-dvh">
          <div className="w-full max-w-[460px]">{children}</div>
        </section>
      </main>
    </div>
  );
}
