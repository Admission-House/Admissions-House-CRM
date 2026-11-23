/**
 * Reads a list of holidays pasted from Excel or Google Sheets (cells separated by tabs) or taken from a CSV file: one
 * holiday a line, a date and a name. The date may be written 25-12-2026, 25/12/2026, 25.12.2026, 2026-12-25 or
 * 25 Dec 2026. A heading line (no date in it) is skipped. Each line is either a holiday or a reason it was not understood.
 */
export interface HolidayLine {
  line: number;
  date?: string;
  name?: string;
  problem?: string;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function iso(y: number, m: number, d: number): string | null {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null; // 31-02 and the like
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** A date as written in India (day first), or as yyyy-mm-dd, or with the month in words. */
export function readDate(text: string): string | null {
  const t = text.trim().replace(/\s+/g, ' ');
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(t);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(t);
  if (m) return iso(Number(m[3]), Number(m[2]), Number(m[1]));
  m = /^(\d{1,2})(?:st|nd|rd|th)?[\s-]([a-z]+)[\s,-]+(\d{4})$/i.exec(t);
  if (m) {
    const month = MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase());
    if (month >= 0) return iso(Number(m[3]), month + 1, Number(m[1]));
  }
  return null;
}

/** Splits one line into its cells: tabs (pasted from a sheet), else commas or semicolons (CSV). */
function cells(line: string): string[] {
  const sep = line.includes('\t') ? '\t' : line.includes(';') && !line.includes(',') ? ';' : ',';
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted;
    } else if (ch === sep && !quoted) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim()).filter((c) => c !== '');
}

export function readHolidaySheet(text: string): HolidayLine[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const out: HolidayLine[] = [];
  let seenHoliday = false;
  lines.forEach((raw, i) => {
    if (!raw.trim()) return;
    const parts = cells(raw);
    const at = parts.findIndex((p) => readDate(p) !== null);
    if (at < 0) {
      // A heading such as "Date, Holiday" before the first holiday is not a mistake.
      if (!seenHoliday && out.length === 0) return;
      out.push({ line: i + 1, problem: 'No date found. Write it like 25-12-2026.' });
      return;
    }
    seenHoliday = true;
    const date = readDate(parts[at]!)!;
    const name = parts.filter((_p, j) => j !== at).join(' ').trim();
    if (name.length < 2) out.push({ line: i + 1, date, problem: 'The holiday needs a name.' });
    else if (name.length > 80) out.push({ line: i + 1, date, problem: 'The name is longer than 80 letters.' });
    else out.push({ line: i + 1, date, name });
  });
  // The same date twice in the list: keep the first.
  const first = new Map<string, number>();
  for (const h of out) {
    if (!h.date || h.problem) continue;
    if (first.has(h.date)) { h.problem = `Same date as line ${first.get(h.date)}.`; } else first.set(h.date, h.line);
  }
  return out;
}
