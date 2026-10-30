import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { calendarDate } from '../common/dates.js';
import { pageQuerySchema } from '../common/pagination.js';

const year = z.coerce.number().int().min(2000).max(2100);

export const createHolidaySchema = z.object({ date: calendarDate, name: z.string().trim().min(2).max(80) });
export class CreateHolidayDto extends createZodDto(createHolidaySchema) {}

export const updateHolidaySchema = z.object({ name: z.string().trim().min(2).max(80) });
export class UpdateHolidayDto extends createZodDto(updateHolidaySchema) {}

export class ListHolidaysDto extends createZodDto(z.object({ year: year.optional() })) {}

export const createLeaveTypeSchema = z.object({
  name: z.string().trim().min(2).max(40),
  /** A paid type takes days from the yearly balance; an unpaid one has no balance. */
  isPaid: z.boolean(),
  /** Days each person gets every year. Halves are allowed. */
  yearlyQuota: z.number().min(0).max(365).multipleOf(0.5),
});
export class CreateLeaveTypeDto extends createZodDto(createLeaveTypeSchema) {}

export const updateLeaveTypeSchema = createLeaveTypeSchema
  .extend({ isActive: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field to change');
export class UpdateLeaveTypeDto extends createZodDto(updateLeaveTypeSchema) {}

export const createRequestSchema = z
  .object({
    leaveTypeId: z.uuid(),
    fromDate: calendarDate,
    /** Defaults to the first day. */
    toDate: calendarDate.optional(),
    halfDay: z.boolean().default(false),
    reason: z.string().trim().max(300).optional(),
  })
  .transform((v) => ({ ...v, toDate: v.toDate ?? v.fromDate }));
export class CreateLeaveRequestDto extends createZodDto(createRequestSchema) {}

export const decisionSchema = z
  .object({
    decision: z.enum(['approved', 'rejected']),
    note: z.string().trim().max(300).optional(),
  })
  .refine((v) => v.decision === 'approved' || (v.note?.length ?? 0) >= 3, {
    message: 'Give a short reason when turning a request down',
    path: ['note'],
  });
export class DecisionDto extends createZodDto(decisionSchema) {}

export const listRequestsSchema = pageQuerySchema.extend({
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
  userId: z.uuid().optional(),
  from: calendarDate.optional(),
  to: calendarDate.optional(),
});
export class ListLeaveRequestsDto extends createZodDto(listRequestsSchema) {}

export class BalancesQueryDto extends createZodDto(z.object({ year: year.optional(), userId: z.uuid().optional() })) {}
