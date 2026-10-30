import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { calendarDate } from '../common/dates.js';
import { normalizePhone } from '../common/phone.js';

const phone = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const normalized = normalizePhone(value);
    if (!normalized) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid mobile number' });
      return z.NEVER;
    }
    return normalized;
  });

const text = (max: number) => z.string().trim().max(max);
const unique = <T>(items: T[], key: (item: T) => string, ctx: z.RefinementCtx, what: string) => {
  const seen = new Set<string>();
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) ctx.addIssue({ code: 'custom', message: `${what} is listed twice: ${k}` });
    seen.add(k);
  }
};

// ------------------------------------------------------------------- sections

export const personalSchema = z
  .object({
    alternateEmail: z.string().trim().toLowerCase().email().max(254).nullable(),
    dateOfBirth: calendarDate
      .refine((d) => d <= new Date().toISOString().slice(0, 10), 'The date of birth cannot be in the future')
      .refine((d) => d >= '1940-01-01', 'Check the year of birth')
      .nullable(),
    gender: z.enum(['male', 'female', 'other']).nullable(),
    category: z.enum(['general', 'obc', 'sc', 'st', 'ews', 'other']).nullable(),
    /** A city, or a state when the city is not known. */
    currentLocationId: z.uuid().nullable(),
    /** Replaces the whole list of extra numbers. */
    extraPhones: z
      .array(z.object({ phone, label: z.enum(['alternate', 'parent', 'whatsapp', 'other']).default('alternate') }))
      .max(5)
      .superRefine((list, ctx) => unique(list, (p) => p.phone, ctx, 'A phone number')),
  })
  .partial();

export const preferencesSchema = z
  .object({
    preferredYear: z.number().int().min(2000).max(2100).nullable(),
    preferredLevel: z.enum(['UG', 'PG', 'Diploma']).nullable(),
    preferredStreamId: z.uuid().nullable(),
    budgetMin: z.number().min(0).max(100_000_000).nullable(),
    budgetMax: z.number().min(0).max(100_000_000).nullable(),
    loanRequired: z.boolean().nullable(),
    /** Replaces the whole list of preferred states and cities. */
    preferredLocationIds: z.array(z.uuid()).max(20).transform((ids) => [...new Set(ids)]),
  })
  .partial();

export const guardianSchema = z.object({
  relation: z.enum(['father', 'mother', 'guardian', 'other']),
  name: text(80).nullable().default(null),
  phone: phone.nullable().default(null),
  occupation: text(80).nullable().default(null),
});

export const educationSchema = z
  .object({
    level: z.enum(['10th', '12th', 'diploma', 'graduation', 'post_graduation']),
    marksType: z.enum(['percentage', 'cgpa']).nullable().default(null),
    marks: z.number().min(0).max(100).nullable().default(null),
    institution: text(120).nullable().default(null),
    board: text(80).nullable().default(null),
    passingYear: z.number().int().min(1980).max(2100).nullable().default(null),
  })
  .superRefine((e, ctx) => {
    if (e.marks !== null && e.marksType === null) ctx.addIssue({ code: 'custom', path: ['marksType'], message: 'Say whether the marks are a percentage or a CGPA' });
    if (e.marksType === 'cgpa' && e.marks !== null && e.marks > 10) ctx.addIssue({ code: 'custom', path: ['marks'], message: 'A CGPA is out of 10' });
  });

export const examSchema = z
  .object({
    examName: text(60).min(2),
    marksType: z.enum(['score', 'rank', 'percentile']).nullable().default(null),
    score: z.number().min(0).max(10_000_000).nullable().default(null),
    examYear: z.number().int().min(2000).max(2100).nullable().default(null),
  })
  .superRefine((e, ctx) => {
    if (e.marksType === 'percentile' && e.score !== null && e.score > 100) ctx.addIssue({ code: 'custom', path: ['score'], message: 'A percentile is out of 100' });
  });

// ----------------------------------------------------------------- the update

/**
 * Each section is optional. A section that is sent replaces that section; one left out is not touched.
 * Inside "personal" and "preferences", fields left out are kept as they are.
 */
export const updateProfileSchema = z
  .object({
    personal: personalSchema,
    preferences: preferencesSchema,
    guardians: z.array(guardianSchema).max(4).superRefine((l, ctx) => unique(l, (g) => g.relation, ctx, 'A relation')),
    education: z.array(educationSchema).max(5).superRefine((l, ctx) => unique(l, (e) => e.level, ctx, 'An education level')),
    exams: z.array(examSchema).max(10).superRefine((l, ctx) => unique(l, (e) => `${e.examName.toLowerCase()}/${e.examYear ?? ''}`, ctx, 'An exam')),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one section to change');
export class UpdateProfileDto extends createZodDto(updateProfileSchema) {}
