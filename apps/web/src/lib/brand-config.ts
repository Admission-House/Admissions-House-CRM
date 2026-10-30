/**
 * What the sign-in screen says before anyone has signed in, so before the company's own name is
 * known. Each value can be set at build time in the environment; the defaults are the product's own.
 */
export const BRAND = {
  product: process.env.NEXT_PUBLIC_PRODUCT_NAME ?? 'Admissions House CRM',
  eyebrow: process.env.NEXT_PUBLIC_LOGIN_EYEBROW ?? 'Admissions House CRM',
  title: process.env.NEXT_PUBLIC_LOGIN_TITLE ?? 'Every student, every follow-up, in one place.',
  tagline: process.env.NEXT_PUBLIC_LOGIN_TAGLINE ?? 'Leads, calls, counselling and your team, together.',
  /** Shown under the sign-in form only when set. */
  supportEmail: process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? '',
  manualUrl: process.env.NEXT_PUBLIC_USER_MANUAL_URL ?? '',
  helpUrl: process.env.NEXT_PUBLIC_HELP_URL ?? '',
} as const;
