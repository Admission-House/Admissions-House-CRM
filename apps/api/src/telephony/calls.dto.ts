import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { calendarDate } from '../common/dates.js';
import { pageQuerySchema } from '../common/pagination.js';
import { changeStatusSchema } from '../leads/leads.dto.js';

export const OUTCOMES = ['requested', 'ringing', 'connected', 'not_picked', 'busy', 'failed', 'missed'] as const;

export const placeCallSchema = z.object({
  /** One of the lead's numbers. Leave out to call the main number. */
  phone: z.string().trim().max(20).optional(),
});
export class PlaceCallDto extends createZodDto(placeCallSchema) {}

export const listCallsSchema = pageQuerySchema.extend({
  leadId: z.uuid().optional(),
  userId: z.uuid().optional(),
  direction: z.enum(['incoming', 'outgoing']).optional(),
  outcome: z.enum(OUTCOMES).optional(),
  from: calendarDate.optional(),
  to: calendarDate.optional(),
  /** Calls whose after-call form has not been filled in. */
  unwrapped: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});
export class ListCallsDto extends createZodDto(listCallsSchema) {}

/** The after-call form: what the lead's status is now, a remark, and when to follow up. */
export const wrapUpSchema = changeStatusSchema;
export class WrapUpDto extends createZodDto(wrapUpSchema) {}
