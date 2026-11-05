import { z } from 'zod';

export const TEAM_SIZES = ['1 to 10 counsellors', '11 to 30 counsellors', '31 to 100 counsellors', 'More than 100 counsellors'] as const;

/** A mobile number as people type it: spaces, dashes, +91 or a leading 0 are fine. Returns ten digits, or null. */
export function normalisePhone(text: string): string | null {
  const digits = text.replace(/\D/g, '');
  const ten = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits.length === 11 && digits.startsWith('0') ? digits.slice(1) : digits;
  return /^[6-9]\d{9}$/.test(ten) ? ten : null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const demoRequestSchema = z.object({
  name: z.string().trim().min(2, 'Tell us your name').max(80),
  email: z.string().trim().max(254).refine((v) => EMAIL.test(v), 'Enter an email address, for example name@company.com'),
  phone: z.string().trim().refine((v) => normalisePhone(v) !== null, 'Enter a 10 digit mobile number'),
  company: z.string().trim().min(2, 'Tell us the name of your company').max(100),
  city: z.string().trim().max(60).optional().default(''),
  teamSize: z.enum(TEAM_SIZES, { message: 'Choose the size of your team' }),
  message: z.string().trim().max(600).optional().default(''),
  /** A field real visitors never see. A robot that fills it in is quietly ignored. */
  website: z.string().optional().default(''),
});
export type DemoRequest = z.infer<typeof demoRequestSchema>;

export interface LeadPayload {
  id: string;
  createdAt: string;
  name: string;
  phone: string;
  email: string;
  city?: string;
  interest: string;
  source: string;
  page: string;
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * The lead the CRM's intake API expects. The company, team size and message have no field of their own
 * there, so they go into "interest" (free text, 300 characters) where the counsellor reads them first.
 */
export function toLead(input: DemoRequest, meta: { id: string; now: Date }): LeadPayload {
  const phone = normalisePhone(input.phone)!;
  const parts = [`Demo request from ${input.company}`, input.teamSize, input.message].filter(Boolean);
  return {
    id: meta.id,
    createdAt: meta.now.toISOString(),
    name: input.name,
    phone,
    email: input.email.toLowerCase(),
    ...(input.city && { city: input.city }),
    interest: clip(parts.join('. '), 300),
    source: 'product-demo-request',
    page: '/demo',
  };
}
