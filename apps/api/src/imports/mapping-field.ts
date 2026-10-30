import { z } from 'zod';

/** Column choices arrive as JSON text in one form field: {"phone": "Mobile No."}. */
export function mappingField<const F extends readonly [string, ...string[]]>(fields: F) {
  return z
    .string()
    .optional()
    .transform((text, ctx) => {
      if (!text) return undefined;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        ctx.addIssue({ code: 'custom', message: 'Must be JSON such as {"phone":"Mobile No."}' });
        return z.NEVER;
      }
    })
    .pipe(z.partialRecord(z.enum(fields), z.string().min(1).max(200)).optional());
}
