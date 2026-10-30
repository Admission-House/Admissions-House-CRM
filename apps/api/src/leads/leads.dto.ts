import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { calendarDate } from '../common/dates.js';
import { pageQuerySchema } from '../common/pagination.js';
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

const instant = z.iso.datetime({ offset: true, message: 'Use a date and time such as 2026-11-03T15:30:00+05:30' }).transform((v) => new Date(v));

export const followUpInputSchema = z.object({
  dueAt: instant,
  note: z.string().trim().max(500).optional(),
  /** Minutes before it is due that the reminder is sent. */
  remindBeforeMin: z.number().int().min(0).max(1440).optional(),
});

export const QUEUES = ['fresh', 'missed', 'followup', 'counselled', 'fee_paid', 'closed'] as const;

// ---------------------------------------------------------------------- list

export const listLeadsSchema = pageQuerySchema.extend({
  q: z.string().trim().max(100).optional(),
  queue: z.enum(QUEUES).optional(),
  statusId: z.uuid().optional(),
  sourceId: z.uuid().optional(),
  /** A person, "me", or "unassigned". */
  assignedTo: z.union([z.uuid(), z.enum(['me', 'unassigned'])]).optional(),
  intent: z.enum(['hot', 'warm', 'cold']).optional(),
  studyMode: z.enum(['online', 'regular']).optional(),
  createdFrom: calendarDate.optional(),
  createdTo: calendarDate.optional(),
  followup: z.enum(['today', 'overdue', 'upcoming']).optional(),
  sort: z.enum(['newest', 'updated', 'followup']).default('newest'),
});
export class ListLeadsDto extends createZodDto(listLeadsSchema) {}

/** The same filters as the list, and the file format. Paging does not apply: the file holds everything that matches. */
export const exportLeadsSchema = listLeadsSchema.omit({ cursor: true, limit: true, sort: true }).extend({ format: z.enum(['csv', 'xlsx']).default('csv') });
export class ExportLeadsDto extends createZodDto(exportLeadsSchema) {}

// -------------------------------------------------------------------- create

export const createLeadSchema = z.object({
  name: z.string().trim().min(2).max(80),
  phone,
  email: z.string().trim().toLowerCase().email().max(254).optional(),
  sourceId: z.uuid(),
  studyMode: z.enum(['online', 'regular']).optional(),
  intent: z.enum(['hot', 'warm', 'cold']).optional(),
  expectedClosureOn: calendarDate.optional(),
  interestedCourseId: z.uuid().optional(),
  interestedLocationId: z.uuid().optional(),
  /** A first note for the history. */
  note: z.string().trim().max(2000).optional(),
  followUp: followUpInputSchema.optional(),
  /**
   * Who gets the lead. Leave out to give it to the person creating it (or, for someone who hands
   * out leads, to the next counsellor in line). null leaves it unassigned.
   */
  assignTo: z.uuid().nullable().optional(),
  /** Hand the lead to assignTo even if they are absent, on leave or on a break. */
  allowUnavailable: z.boolean().optional(),
});
export class CreateLeadDto extends createZodDto(createLeadSchema) {}

// -------------------------------------------------------------------- update

export const updateLeadSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    phone,
    email: z.string().trim().toLowerCase().email().max(254).nullable(),
    intent: z.enum(['hot', 'warm', 'cold']).nullable(),
    studyMode: z.enum(['online', 'regular']).nullable(),
    expectedClosureOn: calendarDate.nullable(),
    interestedCourseId: z.uuid().nullable(),
    interestedLocationId: z.uuid().nullable(),
    interestNote: z.string().trim().max(500).nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field to change');
export class UpdateLeadDto extends createZodDto(updateLeadSchema) {}

// -------------------------------------------------------------------- status

export const changeStatusSchema = z.object({
  statusId: z.uuid(),
  substatusId: z.uuid().nullable().optional(),
  remark: z.string().trim().max(1000).optional(),
  followUp: followUpInputSchema.optional(),
});
export class ChangeStatusDto extends createZodDto(changeStatusSchema) {}

export const assignSchema = z.object({ userId: z.uuid().nullable(), allowUnavailable: z.boolean().optional() });
export class AssignDto extends createZodDto(assignSchema) {}

const leadIds = z.array(z.uuid()).min(1).max(200).transform((ids) => [...new Set(ids)]);
export const bulkAssignSchema = z.object({ leadIds, userId: z.uuid().nullable(), allowUnavailable: z.boolean().optional() });
export class BulkAssignDto extends createZodDto(bulkAssignSchema) {}

export const bulkStatusSchema = z.object({
  leadIds,
  statusId: z.uuid(),
  substatusId: z.uuid().nullable().optional(),
  remark: z.string().trim().max(1000).optional(),
});
export class BulkStatusDto extends createZodDto(bulkStatusSchema) {}

export const noteSchema = z.object({ remark: z.string().trim().min(1).max(2000) });
export class NoteDto extends createZodDto(noteSchema) {}

// ------------------------------------------------------------ status settings

export const createStatusSchema = z.object({
  name: z.string().trim().min(2).max(60),
  queue: z.enum(QUEUES),
  /** An open status is still being worked on; a closed one ends the lead's journey. */
  isOpen: z.boolean(),
  /** Ask for the next follow-up whenever a lead is moved to this status. */
  requiresFollowup: z.boolean(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});
export class CreateStatusDto extends createZodDto(createStatusSchema) {}

export const updateStatusSchema = createStatusSchema
  .extend({ isActive: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field to change');
export class UpdateStatusDto extends createZodDto(updateStatusSchema) {}

export const createSubstatusSchema = z.object({ name: z.string().trim().min(2).max(60), sortOrder: z.number().int().min(0).max(10_000).optional() });
export class CreateSubstatusDto extends createZodDto(createSubstatusSchema) {}
