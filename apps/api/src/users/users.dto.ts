import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { calendarDate } from '../common/dates.js';
import { normalizePhone } from '../common/phone.js';
import { pageQuerySchema } from '../common/pagination.js';

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

const base = {
  name: z.string().trim().min(2).max(80),
  phone: phone.nullable(),
  roleId: z.uuid(),
  branchId: z.uuid().nullable(),
  managerId: z.uuid().nullable(),
  joinedOn: calendarDate.nullable(),
  designation: z.string().trim().max(80).nullable(),
};

export const createUserSchema = z.object({
  name: base.name,
  email: z.string().trim().toLowerCase().email().max(254),
  phone: base.phone.optional(),
  roleId: base.roleId,
  branchId: base.branchId.optional(),
  managerId: base.managerId.optional(),
  joinedOn: base.joinedOn.optional(),
  designation: base.designation.optional(),
});
export class CreateUserDto extends createZodDto(createUserSchema) {}

export const updateUserSchema = z
  .object({ ...base, status: z.enum(['active', 'inactive']) })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field to change');
export class UpdateUserDto extends createZodDto(updateUserSchema) {}

export const listUsersSchema = pageQuerySchema.extend({
  q: z.string().trim().max(100).optional(),
  roleId: z.uuid().optional(),
  branchId: z.uuid().optional(),
  managerId: z.uuid().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});
export class ListUsersDto extends createZodDto(listUsersSchema) {}
