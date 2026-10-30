import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { calendarDate, timeOfDay } from '../common/dates.js';
import { pageQuerySchema } from '../common/pagination.js';

export const startBreakSchema = z.object({ breakTypeId: z.uuid() });
export class StartBreakDto extends createZodDto(startBreakSchema) {}

export const exceptionSchema = z
  .object({
    userId: z.uuid(),
    date: calendarDate,
    /** Why the person is being marked present by hand. Kept in the audit trail. */
    reason: z.string().trim().min(5, 'Give a reason of a few words').max(300),
    /** Defaults to the shift start. */
    checkInTime: timeOfDay.optional(),
    /** Defaults to the shift end for a past day; left open for today. */
    checkOutTime: timeOfDay.optional(),
  })
  .refine((v) => !v.checkInTime || !v.checkOutTime || v.checkOutTime > v.checkInTime, {
    message: 'Check-out must be after check-in',
    path: ['checkOutTime'],
  });
export class CreateExceptionDto extends createZodDto(exceptionSchema) {}

const yesNo = z.enum(['true', 'false']).transform((v) => v === 'true');

export const listAttendanceSchema = pageQuerySchema.extend({
  from: calendarDate.optional(),
  to: calendarDate.optional(),
  userId: z.uuid().optional(),
  branchId: z.uuid().optional(),
  method: z.enum(['office_check', 'exception']).optional(),
  lateOnly: yesNo.optional(),
});
export class ListAttendanceDto extends createZodDto(listAttendanceSchema) {}

export const settingsSchema = z
  .object({
    /** The day the new values start. Defaults to today; cannot be in the past. */
    effectiveFrom: calendarDate.optional(),
    shiftStart: timeOfDay,
    shiftEnd: timeOfDay,
    /** Minutes after the shift start before a check-in counts as late. */
    graceMinutes: z.number().int().min(0).max(180),
    /** Fewer worked hours than this makes the day a half day. */
    halfDayBelowHours: z.number().min(0.5).max(24),
    /** Minutes without activity before a person is signed out. */
    idleTimeoutMin: z.number().int().min(5).max(480),
    /** 0 is Sunday, 6 is Saturday. */
    weeklyOffDays: z
      .array(z.number().int().min(0).max(6))
      .max(7)
      .transform((days) => [...new Set(days)].sort()),
  })
  .refine((v) => v.shiftEnd > v.shiftStart, { message: 'The shift must end after it starts', path: ['shiftEnd'] });
export class UpdateSettingsDto extends createZodDto(settingsSchema) {}

export const createBreakTypeSchema = z.object({
  name: z.string().trim().min(2).max(40),
  /** Minutes a person may take of this break in a day. */
  allowedMinutes: z.number().int().min(1).max(480),
});
export class CreateBreakTypeDto extends createZodDto(createBreakTypeSchema) {}

export const updateBreakTypeSchema = createBreakTypeSchema
  .extend({ isActive: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field to change');
export class UpdateBreakTypeDto extends createZodDto(updateBreakTypeSchema) {}

export const locationLogSchema = z.object({
  from: calendarDate.optional(),
  to: calendarDate.optional(),
  userId: z.uuid().optional(),
  kind: z.enum(['signed_in', 'refused']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export class LocationLogDto extends createZodDto(locationLogSchema) {}
