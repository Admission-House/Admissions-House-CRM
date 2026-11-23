import { DEFAULT_COMPANY } from './company-slug';

/**
 * Which company the person signed in to, kept only while they are signed in, so that signing out (or a
 * session that ends) leads back to that company's own sign-in page and not to the default one. The
 * default company is never stored, and the sign-in page forgets the value, so an address typed by hand
 * still means what it always meant.
 */
const COOKIE = 'ah_company';

function write(value: string | null): void {
  if (typeof document === 'undefined') return;
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = value
    ? `${COOKIE}=${encodeURIComponent(value)}; Path=/; SameSite=Lax${secure}`
    : `${COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
}

/** Called after a successful sign-in. */
export function rememberCompany(slug: string): void {
  write(slug && slug !== DEFAULT_COMPANY ? slug : null);
}

/** Called when the sign-in page opens: from there on, the link in the address bar decides. */
export function forgetCompany(): void {
  write(null);
}

function remembered(): string {
  if (typeof document === 'undefined') return '';
  const hit = document.cookie.split('; ').find((c) => c.startsWith(`${COOKIE}=`));
  return hit ? decodeURIComponent(hit.slice(COOKIE.length + 1)) : '';
}

/** The sign-in page of the company the person was signed in to. */
export function loginPath(): string {
  const slug = remembered();
  return slug ? `/login?company=${encodeURIComponent(slug)}` : '/login';
}

/** The sign-in page for a known company slug (used by pages that already have it from their own link). */
export function loginPathFor(slug: string): string {
  return slug && slug !== DEFAULT_COMPANY ? `/login?company=${encodeURIComponent(slug)}` : '/login';
}
