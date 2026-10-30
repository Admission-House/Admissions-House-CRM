import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const permissionCode = z.string().regex(/^[a-z_]+\.[a-z_]+$/, 'Not a permission code');

const permissions = z
  .array(permissionCode)
  .max(100)
  .transform((codes) => [...new Set(codes)]);

export const createRoleSchema = z.object({
  name: z.string().trim().min(2).max(60),
  /** Whose records the role can see: everyone, their own team, or only their own. */
  dataScope: z.enum(['all', 'team', 'own']),
  /** True if people in this role can sign in only from the office. */
  requiresOffice: z.boolean(),
  permissions,
});
export class CreateRoleDto extends createZodDto(createRoleSchema) {}

export const updateRoleSchema = createRoleSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field to change');
export class UpdateRoleDto extends createZodDto(updateRoleSchema) {}
