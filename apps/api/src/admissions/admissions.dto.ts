import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const recommendSchema = z.object({ collegeId: z.uuid() });
export class RecommendDto extends createZodDto(recommendSchema) {}

const collegeCourseIds = z.array(z.uuid()).max(30).transform((ids) => [...new Set(ids)]);

export const createShortlistSchema = z.object({
  collegeId: z.uuid(),
  /** The courses the student wants at this institute. Their fees are read from the institute, not copied. */
  collegeCourseIds: collegeCourseIds.default([]),
});
export class CreateShortlistDto extends createZodDto(createShortlistSchema) {}

export const updateShortlistSchema = z
  .object({
    formStatus: z.enum(['not_started', 'filled', 'submitted']),
    reconciliationStatus: z.enum(['not_sent', 'mail_sent', 'reconciled']),
    collegeCourseIds,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field to change');
export class UpdateShortlistDto extends createZodDto(updateShortlistSchema) {}

export const paymentSchema = z.object({
  amount: z.number().positive().max(100_000_000),
  /** When it was paid. Defaults to now; cannot be in the future. */
  paidAt: z.iso.datetime({ offset: true }).transform((v) => new Date(v)).optional(),
});
export class PaymentDto extends createZodDto(paymentSchema) {}

export const niDnpSchema = z.object({
  kind: z.enum(['ni', 'dnp']),
  /** Why: not interested, or did not pick. Needed so the next person knows. */
  reason: z.string().trim().min(3, 'Give a short reason').max(300),
});
export class NiDnpDto extends createZodDto(niDnpSchema) {}

export const listShortlistsSchema = z.object({
  /** active: not marked NI/DNP; ni_dnp: marked NI or DNP; reconciled: reconciliation complete. */
  view: z.enum(['all', 'active', 'ni_dnp', 'reconciled']).default('all'),
});
export class ListShortlistsDto extends createZodDto(listShortlistsSchema) {}
