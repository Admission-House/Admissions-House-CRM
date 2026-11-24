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

/**
 * A call made from the counsellor's own mobile, written down afterwards (there is no calling provider to report it).
 * "I called": connected, not picked, busy or switched off / not reachable (failed). "The student called me": connected
 * or missed. Talk time in minutes is asked for a connected call only.
 */
export const logCallSchema = z
  .object({
    direction: z.enum(['outgoing', 'incoming']),
    outcome: z.enum(['connected', 'not_picked', 'busy', 'failed', 'missed']),
    minutes: z.number().int().min(0).max(300).optional(),
    /** One of the lead's numbers. Leave out for the main number. */
    phone: z.string().trim().max(20).optional(),
  })
  .superRefine((v, ctx) => {
    const allowed = v.direction === 'incoming' ? ['connected', 'missed'] : ['connected', 'not_picked', 'busy', 'failed'];
    if (!allowed.includes(v.outcome)) ctx.addIssue({ code: 'custom', path: ['outcome'], message: v.direction === 'incoming' ? 'A call from the student was either answered or missed' : 'Choose what happened on the call' });
    if (v.outcome !== 'connected' && v.minutes !== undefined && v.minutes > 0) ctx.addIssue({ code: 'custom', path: ['minutes'], message: 'Talk time is only for a connected call' });
  });
export class LogCallDto extends createZodDto(logCallSchema) {}

/** The after-call form: what the lead's status is now, a remark, and when to follow up. */
export const wrapUpSchema = changeStatusSchema;
export class WrapUpDto extends createZodDto(wrapUpSchema) {}
