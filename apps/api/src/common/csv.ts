/** Written at the start of a CSV so that Excel reads it as UTF-8 (needed for Hindi names). */
export const CSV_BOM = '﻿';

/**
 * A spreadsheet program treats a cell that begins with = + - @ (or a tab or line break) as a
 * formula, so a name such as =HYPERLINK(...) typed into a lead would run on whoever opens the
 * export. Such text gets a leading apostrophe, which makes it plain text there. Real numbers and
 * dates are not text and are left alone.
 */
export function neutralizeFormula(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

/** One value as it appears in a CSV cell. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = value instanceof Date ? value.toISOString() : typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean' ? String(value) : neutralizeFormula(String(value));
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One line of a CSV, ending in CRLF as the format asks. */
export function csvRow(values: readonly unknown[]): string {
  return `${values.map(csvCell).join(',')}\r\n`;
}
