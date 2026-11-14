import { z } from 'zod';
import { normalizePhone } from './phone.js';

/** A mobile number as a form sends it. It is trimmed and turned into the stored form, or refused with one plain message. */
export const phoneSchema = z
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
