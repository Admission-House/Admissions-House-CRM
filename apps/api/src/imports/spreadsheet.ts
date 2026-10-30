import { parse } from 'csv-parse/sync';
import { readSheet } from 'read-excel-file/node';
import { AppError } from '../common/app-error.js';

export interface Table {
  header: string[];
  rows: string[][];
}

export const MAX_ROWS = 5000;
export const MAX_COLUMNS = 40;
const MAX_CELL = 500;

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]); // the old binary .xls format

const bad = (code: string, message: string, status = 400) => new AppError(code, message, status);

/**
 * Reads an uploaded spreadsheet (.xlsx or CSV) into text cells. What it is comes from its bytes, not
 * its name. Size limits keep one upload from using up the server: at most 5,000 rows and 40 columns.
 */
export async function readTable(data: Buffer): Promise<Table> {
  const grid = data.subarray(0, 4).equals(ZIP) ? await fromXlsx(data) : data.subarray(0, 4).equals(OLE) ? oldExcel() : fromCsv(data);

  const firstFilled = grid.findIndex((row) => row.some((c) => c !== ''));
  if (firstFilled < 0) throw bad('EMPTY_SHEET', 'The file has no data');
  const header = grid[firstFilled]!.map((c) => c.trim());
  while (header.length > 0 && header.at(-1) === '') header.pop();
  if (header.length === 0) throw bad('NO_HEADER', 'The first row must name the columns');
  if (header.length > MAX_COLUMNS) throw bad('TOO_MANY_COLUMNS', `The file has more than ${MAX_COLUMNS} columns`);

  const rows = grid.slice(firstFilled + 1).map((row) => header.map((_h, i) => row[i] ?? ''));
  if (rows.length > MAX_ROWS) throw bad('TOO_MANY_ROWS', `The file has more than ${MAX_ROWS} rows. Split it and import in parts.`, 413);
  return { header, rows };
}

function oldExcel(): never {
  throw bad('OLD_EXCEL', 'This is an old .xls file. Save it as .xlsx or CSV and upload again.', 415);
}

function fromCsv(data: Buffer): string[][] {
  // Text has no zero bytes. A program or an image does, and "save as UTF-8" would be the wrong advice for it.
  if (data.subarray(0, 8192).includes(0)) throw bad('NOT_A_SPREADSHEET', 'This does not look like a spreadsheet', 415);

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    throw bad('NOT_UTF8', 'Save the file as "CSV UTF-8" and upload again. Names in Hindi are lost in other encodings.');
  }
  if (text.includes('\u0000')) throw bad('NOT_A_SPREADSHEET', 'This does not look like a spreadsheet', 415);

  // Excel in some regions separates with ";" or a tab. Use whichever the first line has most of.
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [',', ';', '\t'].map((d) => ({ d, n: firstLine.split(d).length })).sort((a, b) => b.n - a.n)[0]!.d;
  try {
    const records: unknown[][] = parse(text, { delimiter, bom: true, relax_column_count: true, skip_empty_lines: true, relax_quotes: true });
    return records.map((r) => r.map(cell));
  } catch (err) {
    throw bad('BAD_CSV', `The file could not be read as CSV: ${err instanceof Error ? err.message : 'unknown problem'}`);
  }
}

async function fromXlsx(data: Buffer): Promise<string[][]> {
  try {
    const sheet = await readSheet(data);
    return (sheet as unknown[][]).map((r) => r.map(cell));
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'XLS_FILE_NOT_SUPPORTED') return oldExcel();
    throw bad('BAD_XLSX', 'The Excel file could not be read. Check that it opens in Excel and is not password protected.', 415);
  }
}

/** A cell as text. Numbers are written in full: a 12-digit phone number must not become 9.19E+11. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') return Number.isInteger(value) ? BigInt(value).toString() : String(value);
  return String(value).trim().slice(0, MAX_CELL);
}
