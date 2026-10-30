import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { pageQuerySchema } from '../common/pagination.js';
import { followUpInputSchema } from '../leads/leads.dto.js';

export const createFollowUpSchema = followUpInputSchema;
export class CreateFollowUpDto extends createZodDto(createFollowUpSchema) {}

export const rescheduleSchema = z
  .object({
    dueAt: followUpInputSchema.shape.dueAt,
    note: z.string().trim().max(500).nullable(),
    remindBeforeMin: z.number().int().min(0).max(1440),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field to change');
export class RescheduleDto extends createZodDto(rescheduleSchema) {}

export const doneSchema = z.object({ note: z.string().trim().max(500).optional() });
export class DoneDto extends createZodDto(doneSchema) {}

export const listFollowUpsSchema = pageQuerySchema.extend({
  /** today: due today and not done; overdue: past due and not done; upcoming: after today; done: finished. */
  bucket: z.enum(['today', 'overdue', 'upcoming', 'done']).default('today'),
  /** Whose follow-ups, for those who manage a team. Defaults to the caller's own scope. */
  userId: z.uuid().optional(),
});
export class ListFollowUpsDto extends createZodDto(listFollowUpsSchema) {}
