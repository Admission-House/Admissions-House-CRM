'use client';

import Image from 'next/image';
import { BRAND } from '@/lib/brand-config';
import { useCompanySlug } from '@/lib/company-slug';
import { loginBrandFor, type LoginBrand } from '@/lib/login-brand';

/** The logo picture has no background and is cropped close to the logo (994 by 270), so it can sit on anything and be shown large. */
const LOGO = { src: '/brand/brand-logo-clear.png', width: 994, height: 270 } as const;

/**
 * The logo of the sign-in screens. It depends on the company link, which only the browser knows, so it
 * is drawn there (inside a Suspense boundary, like the sign-in form itself) and never shows one company's
 * logo first and then another's.
 */
export function BrandMark({ variant }: { variant: 'panel' | 'strip' }) {
  const brand = loginBrandFor(useCompanySlug());
  if (brand) return <OtherBrand brand={brand} variant={variant} />;
  return variant === 'panel' ? (
    <Image
      {...LOGO}
      alt={BRAND.product}
      priority
      sizes="(min-width: 1024px) 44vw, 0px"
      className="h-auto w-[76%] max-w-[44rem]"
    />
  ) : (
    <Image
      {...LOGO}
      alt={BRAND.product}
      priority
      sizes="320px"
      className="h-auto w-full max-w-[22rem]"
    />
  );
}

export function BrandCopyright() {
  const brand = loginBrandFor(useCompanySlug());
  return (
    <>
      © {new Date().getFullYear()} {brand?.copyright ?? 'Admissions House'}
    </>
  );
}

function OtherBrand({ brand, variant }: { brand: LoginBrand; variant: 'panel' | 'strip' }) {
  const big = variant === 'panel';
  return (
    <div className={`flex items-center ${big ? 'gap-7' : 'gap-4'}`}>
      <Image
        {...brand.icon}
        alt=""
        priority
        sizes={big ? '160px' : '72px'}
        className={big ? 'h-auto w-[clamp(6rem,9vw,9.5rem)]' : 'h-auto w-14'}
      />
      <div className="text-white">
        <p
          className={`font-bold leading-none tracking-tight ${big ? 'text-[clamp(3rem,5.6vw,6rem)]' : 'text-4xl'}`}
        >
          {brand.name}
        </p>
        <p
          className={`mt-2 flex items-center gap-3 font-normal leading-none ${big ? 'text-[clamp(2.25rem,4.2vw,4.5rem)]' : 'text-3xl'}`}
        >
          {brand.subline}
          {brand.tag && (
            <span
              className={`rounded-full border border-white/50 font-semibold uppercase tracking-widest text-white/90 ${big ? 'px-3 py-1 text-sm' : 'px-2 py-0.5 text-[10px]'}`}
            >
              {brand.tag}
            </span>
          )}
        </p>
      </div>
    </div>
  );
}
