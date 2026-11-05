/**
 * Everything that differs from one company to the next, read from the environment so the site can be
 * rebranded without touching a page. The defaults are the details published on admissionshouse.com.
 */
const env = (key: string, fallback: string): string => process.env[key]?.trim() || fallback;

/** +918796648777 shown the way people write it in India: +91 87966 48777. */
export function formatPhone(e164: string): string {
  const m = /^\+91(\d{5})(\d{5})$/.exec(e164);
  return m ? `+91 ${m[1]} ${m[2]}` : e164;
}

const phone = env('SITE_PHONE', '+918796648777');

export const SITE = {
  /** The product's name, as it appears in the header, titles and search results. */
  name: env('SITE_NAME', 'Admissions House CRM'),
  /** The company behind it. */
  company: env('SITE_COMPANY', 'Admissions House'),
  url: env('SITE_URL', 'http://localhost:3100').replace(/\/+$/, ''),
  email: env('SITE_EMAIL', 'info@admissionshouse.com'),
  phone,
  phoneDisplay: formatPhone(phone),
  whatsapp: phone.replace(/\D/g, ''),
  address: env('SITE_ADDRESS', 'B-1207, Tower 4, NX One, Greater Noida West, Uttar Pradesh'),
  hours: env('SITE_HOURS', 'Open daily, 10 am to 8 pm'),
} as const;

/** Where the demo request goes: the lead intake of the company that owns this site, with that company's key for this source. */
export const crm = {
  url: process.env.CRM_WEBHOOK_URL?.trim() ?? '',
  secret: process.env.CRM_WEBHOOK_SECRET?.trim() ?? '',
};

export const whatsappHref = (text: string): string => `https://wa.me/${SITE.whatsapp}?text=${encodeURIComponent(text)}`;
