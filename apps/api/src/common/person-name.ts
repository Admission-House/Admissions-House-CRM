import { z } from 'zod';

/** A person's name as it should be stored: no spaces at the ends, and one space between words however many were typed. */
export const tidyName = (value: string): string => value.replace(/\s+/g, ' ').trim();

/** A name from a form or a file, tidied, between `min` and `max` characters. */
export const personName = (min: number, max: number) => z.string().transform(tidyName).pipe(z.string().min(min).max(max));
