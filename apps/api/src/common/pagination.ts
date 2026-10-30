import { z } from 'zod';
import { AppError } from './app-error.js';

/** Query parameters every list endpoint accepts. The page size is capped. */
export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(500).optional(),
});

export interface Page<T> {
  items: T[];
  /** Pass this as `cursor` to get the next page; null on the last page. */
  nextCursor: string | null;
}

/** A cursor is the sort position of the last row seen. It is opaque to clients. */
export function encodeCursor(position: object): string {
  return Buffer.from(JSON.stringify(position)).toString('base64url');
}

export function decodeCursor<T>(cursor: string | undefined, shape: z.ZodType<T>): T | undefined {
  if (!cursor) return undefined;
  try {
    return shape.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw AppError.badRequest('INVALID_CURSOR', 'The page marker is not valid. Start again from the first page.');
  }
}

/**
 * Turns rows fetched with `limit + 1` into a page. The extra row only tells us whether another
 * page exists; it is not returned.
 */
export function toPage<T>(rows: T[], limit: number, cursorOf: (last: T) => object): Page<T> {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(cursorOf(last)) : null };
}
