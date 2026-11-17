/** A NUL character, or half of a pair of surrogates: text the database cannot store, and which only a faulty or hostile client sends. */
const BAD = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Looks through everything a request carries (text, lists, nested objects) for text that cannot be stored. Returns where
 * the first such text was found (for example "name" or "people.2.note"), or null when all of it is fine.
 */
export function findBadText(value: unknown, path = '', depth = 0): string | null {
  if (typeof value === 'string') return BAD.test(value) ? path || '(value)' : null;
  if (value === null || typeof value !== 'object' || depth > 20) return null;
  for (const [key, inner] of Object.entries(value)) {
    const found = findBadText(inner, path ? `${path}.${key}` : key, depth + 1);
    if (found) return found;
  }
  return null;
}
