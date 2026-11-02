/** Set at build time (EXPO_PUBLIC_*). Nothing about a company is hard-coded in the app. */
export const config = {
  /** The API address, for example https://crm.yourcompany.com. */
  apiUrl: (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/+$/, ''),
  /** The company's sign-in name. When set, people do not have to type it. */
  companySlug: process.env.EXPO_PUBLIC_COMPANY_SLUG ?? '',
  productName: process.env.EXPO_PUBLIC_PRODUCT_NAME ?? 'Admissions House CRM',
} as const;
