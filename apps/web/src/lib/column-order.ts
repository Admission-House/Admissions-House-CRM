// The order of a table's columns. Kept apart from the screen code so it can be tested on its own.

/** The saved order applied to the columns that exist now. */
export function mergeOrder(saved: readonly string[] | null, defaults: readonly string[]): string[] {
  if (!saved) return [...defaults];
  const known = saved.filter((id, i) => defaults.includes(id) && saved.indexOf(id) === i);
  return [...known, ...defaults.filter((id) => !known.includes(id))];
}

/** A new order with `from` moved to where `to` is. */
export function moved(order: readonly string[], from: string, to: string): string[] {
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  if (a < 0 || b < 0 || a === b) return [...order];
  const next = [...order];
  next.splice(a, 1);
  next.splice(b, 0, from);
  return next;
}
