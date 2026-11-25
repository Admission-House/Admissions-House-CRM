import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { calendarDate } from '../common/dates.js';
import { pageQuerySchema } from '../common/pagination.js';
import { personName } from '../common/person-name.js';
import { phoneSchema } from '../common/phone-schema.js';

const phone = phoneSchema;

const instant = z.iso
  .datetime({ offset: true, message: 'Use a date and time such as 2026-11-03T15:30:00+05:30' })
  .transform((v) => new Date(v));

export const followUpInputSchema = z.object({
  dueAt: instant,
  note: z.string().trim().max(500).optional(),
  /** Minutes before it is due that the reminder is sent. */
  remindBeforeMin: z.number().int().min(0).max(1440).optional(),
});

/** The columns of the leads table that can be sorted with the arrows in their heading. */
export const LIST_ORDER_COLUMNS = [
  'name',
  'email',
  'course',
  'region',
  'status',
  'source',
  'assigned',
  'received',
  'followup',
  'updated',
] as const;
export type ListOrderColumn = (typeof LIST_ORDER_COLUMNS)[number];

export const QUEUES = ['fresh', 'missed', 'followup', 'counselled', 'fee_paid', 'closed'] as const;

// ---------------------------------------------------------------------- list

export const listLeadsSchema = pageQuerySchema.extend({
  q: z.string().trim().max(100).optional(),
  /** One queue, or "open": every lead not in the Closed queue (the "All leads" list, where a closed lead leaves the list). */
  queue: z.enum([...QUEUES, 'open']).optional(),
  statusId: z.uuid().optional(),
  sourceId: z.uuid().optional(),
  /** A person, "me", or "unassigned". */
  assignedTo: z.union([z.uuid(), z.enum(['me', 'unassigned'])]).optional(),
  intent: z.enum(['hot', 'warm', 'cold']).optional(),
  studyMode: z.enum(['online', 'regular']).optional(),
  createdFrom: calendarDate.optional(),
  createdTo: calendarDate.optional(),
  /** Received at or after this moment: for "the last 3 hours" and the like, which a calendar date cannot say. */
  createdAfter: z.iso.datetime({ offset: true }).optional(),
  /** Leads whose status is marked as junk: only those, or all the others. */
  junk: z.enum(['only', 'hide']).optional(),
  followup: z.enum(['today', 'overdue', 'upcoming']).optional(),
  sort: z.enum(['newest', 'oldest', 'updated', 'followup']).default('newest'),
  /**
   * Sort by one column of the table, up or down (the arrows in its heading). When given it takes the place of `sort`.
   * Empty values (no email, no follow-up...) always come last, in both directions.
   */
  orderBy: z.enum(LIST_ORDER_COLUMNS).optional(),
  dir: z.enum(['asc', 'desc']).default('asc'),
});
export class ListLeadsDto extends createZodDto(listLeadsSchema) {}

/** The same filters as the list, and the file format. Paging does not apply: the file holds everything that matches. */
export const exportLeadsSchema = listLeadsSchema
  .omit({ cursor: true, limit: true, sort: true })
  .extend({ format: z.enum(['csv', 'xlsx']).default('csv') });
export class ExportLeadsDto extends createZodDto(exportLeadsSchema) {}

// -------------------------------------------------------------------- create

export const createLeadSchema = z.object({
  name: personName(2, 80),
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
    name: personName(2, 80),
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

export const assignSchema = z.object({
  userId: z.uuid().nullable(),
  allowUnavailable: z.boolean().optional(),
});
export class AssignDto extends createZodDto(assignSchema) {}

/** The most leads one bulk action takes: ten pages of the list (100 a page). */
export const MAX_BULK_LEADS = 1000;
const leadIds = z
  .array(z.uuid())
  .min(1)
  .max(MAX_BULK_LEADS, `Choose at most ${MAX_BULK_LEADS} leads at a time`)
  .transform((ids) => [...new Set(ids)]);
export const bulkAssignSchema = z.object({
  leadIds,
  userId: z.uuid().nullable(),
  allowUnavailable: z.boolean().optional(),
});
export class BulkAssignDto extends createZodDto(bulkAssignSchema) {}

/**
 * Moves the leads one person holds to other people, for when someone is not performing and their
 * work must go elsewhere. With several targets the leads are shared out evenly, in turn.
 */
export const transferLeadsSchema = z.object({
  fromUserId: z.uuid(),
  toUserIds: z
    .array(z.uuid())
    .min(1)
    .max(20)
    .transform((ids) => [...new Set(ids)]),
  /** "open" moves only leads still being worked; "all" moves every lead the person holds. */
  which: z.enum(['open', 'all']).default('open'),
  /** Also stop automatic hand-out to the person, so new leads do not pile up on them again. */
  pauseAutomation: z.boolean().default(false),
  allowUnavailable: z.boolean().optional(),
});
export class TransferLeadsDto extends createZodDto(transferLeadsSchema) {}

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
  /** Ask for a sub-status (the reason) whenever a lead is moved to this status. */
  requiresSubstatus: z.boolean().optional(),
  /** Offered in "Dispose lead". Off for a status the system uses or an older one, which stays on the leads that hold it. */
  selectable: z.boolean().optional(),
  /** A lead with this status is a junk lead (fake, wrong or unreachable). */
  isJunk: z.boolean().optional(),
  /** Reaching this status means the lead was won (admission taken): the whole team is told. */
  isWon: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});
export class CreateStatusDto extends createZodDto(createStatusSchema) {}

export const updateStatusSchema = createStatusSchema
  .extend({ isActive: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field to change');
export class UpdateStatusDto extends createZodDto(updateStatusSchema) {}

export const createSubstatusSchema = z.object({
  name: z.string().trim().min(2).max(60),
  /** A comment must be written whenever this sub-status is chosen, as for "Other reasons". */
  requiresComment: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});
export class CreateSubstatusDto extends createZodDto(createSubstatusSchema) {}
