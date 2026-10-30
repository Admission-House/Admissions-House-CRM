import { z } from 'zod';

/** A calendar date as YYYY-MM-DD. It has no time zone: it is the day on the wall calendar. */
export const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
  .refine((v) => {
    const parsed = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(v);
  }, 'Not a real date');

/** A time of day as HH:MM (24 hour). */
export const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use the format HH:MM (24 hour)');
