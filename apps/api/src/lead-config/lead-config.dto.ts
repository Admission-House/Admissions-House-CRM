import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const createSourceSchema = z.object({
  name: z.string().trim().min(2).max(60),
  channelType: z.enum(['website', 'ads', 'portal', 'call', 'referral', 'walk_in', 'import', 'other']),
});
export class CreateSourceDto extends createZodDto(createSourceSchema) {}

export const updateSourceSchema = createSourceSchema
  .extend({ isActive: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field to change');
export class UpdateSourceDto extends createZodDto(updateSourceSchema) {}

const ruleBase = z.object({
  name: z.string().trim().min(2).max(80),
  /** Rules are tried from the lowest number up; the first that matches decides. */
  priority: z.number().int().min(1).max(10_000),
  /** Conditions: leave out (or null) for "any". */
  sourceId: z.uuid().nullable().default(null),
  courseId: z.uuid().nullable().default(null),
  locationId: z.uuid().nullable().default(null),
  studyMode: z.enum(['online', 'regular']).nullable().default(null),
  strategy: z.enum(['round_robin', 'least_busy', 'fixed']),
  /** The people who can receive leads from this rule. Empty means every counsellor. */
  userIds: z.array(z.uuid()).max(200).transform((ids) => [...new Set(ids)]),
  isActive: z.boolean().default(true),
});
export const createRuleSchema = ruleBase;
export class CreateRuleDto extends createZodDto(createRuleSchema) {}

export const updateRuleSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    priority: z.number().int().min(1).max(10_000),
    sourceId: z.uuid().nullable(),
    courseId: z.uuid().nullable(),
    locationId: z.uuid().nullable(),
    studyMode: z.enum(['online', 'regular']).nullable(),
    strategy: z.enum(['round_robin', 'least_busy', 'fixed']),
    userIds: z.array(z.uuid()).max(200).transform((ids) => [...new Set(ids)]),
    isActive: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field to change');
export class UpdateRuleDto extends createZodDto(updateRuleSchema) {}

export const policySchema = z.object({
  /** What to do when the same phone number enquires again: add to the existing lead, or refuse. */
  duplicateAction: z.enum(['attach', 'reject']),
  /** Give new leads to counsellors automatically. */
  autoAssign: z.boolean(),
  /** Words in a website form's name that mean a download ("brochure"). Super Admins are told when one arrives. Leave out to keep the current list. */
  downloadForms: z.array(z.string().trim().min(2).max(40)).max(20).transform((v) => [...new Set(v.map((x) => x.toLowerCase()))]).optional(),
});
export class PolicyDto extends createZodDto(policySchema) {}
