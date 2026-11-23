/**
 * The brand the sign-in screens show for a company link (?company=<slug>). A company that is not
 * listed shows the product's own Admissions House brand, so the real sign-in page never changes.
 */
export interface LoginBrand {
  /** A square-ish mark shown beside the name. */
  icon: { src: string; width: number; height: number };
  name: string;
  /** Second line under the name, lighter. */
  subline: string;
  /** Small label beside the subline, for example "Demo". */
  tag?: string;
  copyright: string;
}

const BRANDS: Record<string, LoginBrand> = {
  'podversal-demo': {
    icon: { src: '/brand/podversal-icon.png', width: 347, height: 480 },
    name: 'Podversal',
    subline: 'CRM',
    tag: 'Demo',
    copyright: 'Podversal',
  },
};

export function loginBrandFor(slug: string): LoginBrand | undefined {
  return BRANDS[slug];
}
