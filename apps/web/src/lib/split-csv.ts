/** The most rows one part may hold: the same limit the server puts on one file. */
export const PART_ROWS = 5000;
/** The biggest a part may be, so it stays under the limit on what one request can carry. */
export const PART_BYTES = 3 * 1024 * 1024;

export interface CsvParts {
  /** The data rows in the whole file, not counting the heading row or blank lines. */
  rows: number;
  /** Each part is the heading row followed by its share of the rows. */
  parts: string[];
}

/** The lines of CSV text. A line break inside quotes belongs to the cell, so it does not end the line. */
function records(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 34) quoted = !quoted; // a doubled quote inside a cell flips twice and so changes nothing
    else if (!quoted && (c === 10 || c === 13)) {
      out.push(text.slice(start, i));
      if (c === 13 && text.charCodeAt(i + 1) === 10) i++;
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/**
 * Cuts a large CSV into parts the server can take one request at a time. The heading row is repeated at the top of
 * every part, so each part is a file on its own, and a cell with a line break in it is never cut in two.
 */
export function splitCsv(text: string, maxRows = PART_ROWS, maxBytes = PART_BYTES): CsvParts {
  const bom = text.charCodeAt(0) === 0xfeff ? '﻿' : '';
  const lines = records(bom ? text.slice(1) : text);
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0) return { rows: 0, parts: [] };
  const header = lines[first]!;
  const body = lines.slice(first + 1).filter((l) => l.trim() !== '');

  const parts: string[] = [];
  let current: string[] = [];
  let bytes = header.length;
  const close = () => {
    if (current.length > 0) parts.push(`${bom}${header}\n${current.join('\n')}\n`);
    current = [];
    bytes = header.length;
  };
  for (const line of body) {
    if (current.length >= maxRows || (current.length > 0 && bytes + line.length + 1 > maxBytes)) close();
    current.push(line);
    bytes += line.length + 1;
  }
  close();
  return { rows: body.length, parts };
}
