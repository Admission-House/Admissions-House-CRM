import { parse } from 'csv-parse/sync';
import writeXlsxFile from 'write-excel-file/node';
import { AppError } from '../common/app-error.js';
import { csvCell, csvRow, neutralizeFormula } from '../common/csv.js';
import { applyOverride, detectMapping, repeatsInFile, toRecords, validateRecords } from './import-rules.js';
import { MAX_COLUMNS, MAX_ROWS, readTable } from './spreadsheet.js';

const codeOf = async (fn: () => unknown): Promise<string | undefined> => {
  try {
    await fn();
  } catch (e) {
    return e instanceof AppError ? e.code : 'NOT_AN_APP_ERROR';
  }
  return undefined;
};

const csv = (text: string) => Buffer.from(text, 'utf8');

// ----------------------------------------------------------------- writing CSV

describe('CSV cells', () => {
  it.each([
    ['=HYPERLINK("http://evil.example","click")', "'=HYPERLINK(\"http://evil.example\",\"click\")"],
    ['+91 98765 43210', "'+91 98765 43210"],
    ['-5', "'-5"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\tTabbed', "'\tTabbed"],
    ['Riya', 'Riya'],
    ['A = B', 'A = B'],
  ])('neutralizes a formula: %j', (input, expected) => {
    expect(neutralizeFormula(input)).toBe(expected);
  });

  it('quotes what needs it and leaves the rest', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('has, comma')).toBe('"has, comma"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('writes numbers, booleans and dates as they are, not as formulas', () => {
    expect(csvCell(-12.5)).toBe('-12.5');
    expect(csvCell(true)).toBe('true');
    expect(csvCell(new Date('2026-10-28T10:00:00Z'))).toBe('2026-10-28T10:00:00.000Z');
    expect(csvCell(10n)).toBe('10');
  });

  it('writes a line that reads back as the same values (apart from the protective apostrophe)', () => {
    const values = ['Riya, Sharma', 'say "hi"', 'line\nbreak', 'सिया का आधार', 42, ''];
    const [row] = parse(csvRow(values), { bom: false }) as string[][];
    expect(row).toEqual(['Riya, Sharma', 'say "hi"', 'line\nbreak', 'सिया का आधार', '42', '']);
    expect(csvRow(['=1+1'])).toBe("'=1+1\r\n");
  });
});

// ----------------------------------------------------------------- reading files

describe('readTable: CSV', () => {
  it('reads a simple file, ignoring a byte-order mark and blank lines', async () => {
    const t = await readTable(csv('﻿Name,Mobile\r\nRiya,9876543210\r\n\r\nAsha,9876543211\r\n'));
    expect(t).toEqual({ header: ['Name', 'Mobile'], rows: [['Riya', '9876543210'], ['Asha', '9876543211']] });
  });

  it.each([[';'], ['\t']])('reads a file separated by %j', async (d) => {
    const t = await readTable(csv(`Name${d}Mobile\nRiya${d}9876543210\n`));
    expect(t.rows).toEqual([['Riya', '9876543210']]);
  });

  it('reads quoted cells with commas, quotes and line breaks, and Hindi text', async () => {
    const t = await readTable(csv('Name,Interest\n"Sharma, Riya","B.Tech ""CSE""\nsecond line"\nसिया,एमबीए\n'));
    expect(t.rows).toEqual([['Sharma, Riya', 'B.Tech "CSE"\nsecond line'], ['सिया', 'एमबीए']]);
  });

  it('skips blank rows before the header, and fills short rows', async () => {
    const t = await readTable(csv(',,\n\nName,Mobile,Email\nRiya,9876543210\n'));
    expect(t.header).toEqual(['Name', 'Mobile', 'Email']);
    expect(t.rows).toEqual([['Riya', '9876543210', '']]);
  });

  it('refuses a file that is not UTF-8, saying how to fix it', async () => {
    const latin1 = Buffer.from([0x4e, 0x61, 0x6d, 0x65, 0x0a, 0x52, 0xe9, 0x73, 0x75, 0x6d, 0xe9, 0x0a]); // "Résumé" in Latin-1
    expect(await codeOf(() => readTable(latin1))).toBe('NOT_UTF8');
  });

  it.each([
    ['an empty file', Buffer.alloc(0)],
    ['only blank lines', csv('\n\n  \n')],
  ])('refuses %s', async (_n, data) => {
    expect(await codeOf(() => readTable(data))).toBe('EMPTY_SHEET');
  });

  it('accepts a file with a header and no rows', async () => {
    expect(await readTable(csv('Name,Mobile\n'))).toEqual({ header: ['Name', 'Mobile'], rows: [] });
  });

  it('refuses binary data that is not a spreadsheet', async () => {
    expect(await codeOf(() => readTable(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00])))).toBe('NOT_A_SPREADSHEET');
  });

  it('refuses the old .xls format, saying what to do', async () => {
    expect(await codeOf(() => readTable(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.alloc(100)])))).toBe('OLD_EXCEL');
  });

  it('keeps to the size limits', async () => {
    const many = 'Name,Mobile\n' + Array.from({ length: MAX_ROWS + 1 }, (_v, i) => `P${i},${i}`).join('\n');
    expect(await codeOf(() => readTable(csv(many)))).toBe('TOO_MANY_ROWS');
    const exact = 'Name,Mobile\n' + Array.from({ length: MAX_ROWS }, (_v, i) => `P${i},${i}`).join('\n');
    expect((await readTable(csv(exact))).rows).toHaveLength(MAX_ROWS);
    const wide = Array.from({ length: MAX_COLUMNS + 1 }, (_v, i) => `c${i}`).join(',');
    expect(await codeOf(() => readTable(csv(`${wide}\n`)))).toBe('TOO_MANY_COLUMNS');
  });
});

describe('readTable: Excel', () => {
  const xlsx = (rows: unknown[][]) =>
    writeXlsxFile(rows.map((r) => r.map((value) => (value === null ? { value: '' } : typeof value === 'string' ? { value, type: String } : value instanceof Date ? { value, format: 'yyyy-mm-dd' } : { value } as never)))).toBuffer();

  it('reads an .xlsx file, writing a number out in full', async () => {
    const t = await readTable(await xlsx([['Name', 'Mobile', 'Joined'], ['Riya', 919876543210, new Date('2026-10-28T00:00:00Z')], ['Asha', '09876543211', null]]));
    expect(t.header).toEqual(['Name', 'Mobile', 'Joined']);
    expect(t.rows[0]).toEqual(['Riya', '919876543210', '2026-10-28']);
    expect(t.rows[1]).toEqual(['Asha', '09876543211', '']);
  });

  it('refuses a file that claims to be a spreadsheet but is not', async () => {
    const fake = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('this is not really a zip archive')]);
    expect(await codeOf(() => readTable(fake))).toBe('BAD_XLSX');
  });
});

// ------------------------------------------------------------- finding columns

describe('detectMapping', () => {
  it('finds columns by the names people use', () => {
    const { mapping, unmapped } = detectMapping(['Student Name', 'Mobile No.', 'E-mail ID', 'Course', 'City', 'Study Mode', 'Remarks']);
    expect(mapping).toEqual({ name: 0, phone: 1, email: 2, interest: 3, city: 4, mode: 5 });
    expect(unmapped).toEqual(['Remarks']);
  });

  it('knows a Hindi header and campaign columns', () => {
    const { mapping } = detectMapping(['नाम', 'Phone', 'UTM Source', 'utm_campaign']);
    expect(mapping).toMatchObject({ name: 0, phone: 1, utm_source: 2, utm_campaign: 3 });
  });

  it('uses a column once and the first one that matches', () => {
    const { mapping } = detectMapping(['Mobile', 'Contact', 'Name']);
    expect(mapping.phone).toBe(0);
    expect(Object.values(mapping)).toEqual([2, 0]);
  });

  it('can be corrected by naming the column', () => {
    const header = ['Candidate', 'Number'];
    const base = detectMapping(header).mapping;
    expect(base.phone).toBeUndefined();
    expect(applyOverride(header, base, { phone: 'Number', name: 'No such column' })).toMatchObject({ phone: 1 });
  });
});

describe('toRecords and validateRecords', () => {
  const table = {
    header: ['Name', 'Mobile', 'Email', 'Mode'],
    rows: [
      ['Riya Sharma', '98765 43210', 'RIYA@EXAMPLE.COM', 'Online'],
      ['', '', '', ''],
      ['No Phone', '', '', ''],
      ['Bad Phone', '12345', '', ''],
      ['Asha K', '+91 98765 43211', 'not-an-email', 'Hybrid'],
      ['Riya Again', '9876543210', '', ''],
    ],
  };
  const { mapping } = detectMapping(table.header);

  it('numbers rows as the spreadsheet does and skips empty ones', () => {
    expect(toRecords(table, mapping).map((r) => r.row)).toEqual([2, 4, 5, 6, 7]);
  });

  it('sorts rows into those that can be filed and those that cannot, with the reason', () => {
    const { valid, invalid } = validateRecords(toRecords(table, mapping), 'import: leads.csv');
    expect(valid.map((v) => [v.row, v.lead.phone])).toEqual([[2, '919876543210'], [6, '919876543211'], [7, '919876543210']]);
    expect(valid[0]!.lead).toMatchObject({ name: 'Riya Sharma', email: 'riya@example.com', studyMode: 'online', formName: 'import: leads.csv' });
    expect(valid[1]!.lead).toMatchObject({ email: undefined, studyMode: undefined }); // bad optional details are dropped, the lead is kept
    expect(invalid.map((i) => [i.row, i.name])).toEqual([[4, 'No Phone'], [5, 'Bad Phone']]);
    expect(invalid[0]!.problem).toContain('phone');
    expect(invalid[1]!.problem).toContain('not a valid mobile number');
  });

  it('counts repeats of a phone number within the file', () => {
    const { valid } = validateRecords(toRecords(table, mapping), 'x');
    expect(repeatsInFile(valid)).toBe(1);
  });
});
