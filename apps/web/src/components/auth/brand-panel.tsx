import Image from 'next/image';
import { BRAND } from '@/lib/brand-config';

/** The deep green of the logo picture itself, so the picture and the panel around it are one surface. */
export const PANEL_GREEN = '#073c3a';

/** A deep teal-black used for the tint over the photo. */
const TINT = '#052a29';

/** The logo picture has no background and is cropped close to the logo (994 by 270), so it can sit on anything and be shown large. */
const LOGO = { src: '/brand/brand-logo-clear.png', width: 994, height: 270 } as const;

/**
 * The left half of the sign-in screens: one still photo of a smiling graduate fills it under an even
 * deep-teal tint, and the logo stands in the middle. On a phone the half is
 * hidden and the logo sits as a strip above the form instead.
 */
export function BrandPanel() {
  return (
    <aside className="relative hidden overflow-hidden lg:block" style={{ background: PANEL_GREEN }}>
      <Image
        src="/brand/login-graduate.jpg"
        alt="A graduate smiling with her diploma"
        fill
        priority
        sizes="(min-width: 1024px) 50vw, 0px"
        style={{ objectPosition: '50% 35%' }}
        className="object-cover"
      />
      {/* One even tint over the whole photo, a little deeper towards the bottom: no bands, and the photo's own colours still show. */}
      <div aria-hidden className="absolute inset-0" style={{ background: `linear-gradient(to bottom, ${TINT}73 0%, ${TINT}8c 50%, ${TINT}b3 100%)` }} />
      {/* A very wide, soft shade behind the middle so the logo reads; it has no edge to see. */}
      <div aria-hidden className="absolute inset-0" style={{ background: `radial-gradient(ellipse 130% 55% at 50% 50%, ${TINT}66 0%, ${TINT}33 55%, transparent 100%)` }} />

      <div className="relative flex h-full flex-col items-center justify-center">
        <Image {...LOGO} alt={BRAND.product} priority sizes="(min-width: 1024px) 44vw, 0px" className="h-auto w-[76%] max-w-[44rem]" />
        <p className="absolute inset-x-0 bottom-8 text-center text-xs tracking-wide text-white/75">© {new Date().getFullYear()} Admissions House</p>
      </div>
    </aside>
  );
}

export function BrandStrip() {
  return (
    <div className="flex justify-center px-8 py-9 lg:hidden" style={{ background: PANEL_GREEN }}>
      <Image {...LOGO} alt={BRAND.product} priority sizes="320px" className="h-auto w-full max-w-[22rem]" />
    </div>
  );
}
