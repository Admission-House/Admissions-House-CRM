'use client';

import { useSearchParams } from 'next/navigation';

/** The company the screens sign in to unless the link says otherwise. Set NEXT_PUBLIC_DEFAULT_COMPANY at build time. */
const DEFAULT_COMPANY = process.env.NEXT_PUBLIC_DEFAULT_COMPANY ?? '';

/**
 * Which company to sign in to. The form does not ask: this product is run for one company, so the
 * address is chosen here: ?company= in the link (for support and for demos), else the one the
 * product was built for. Nothing is remembered between visits, so a link always means the same thing.
 */
export function useCompanySlug(): string {
  const fromLink = useSearchParams().get('company')?.trim().toLowerCase() ?? '';
  return fromLink || DEFAULT_COMPANY;
}
