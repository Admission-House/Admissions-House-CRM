import { detectMasterMapping, parseAmount, parseMasterRows } from './master-import-rules.js';

describe('parseAmount', () => {
  it.each([
    ['125000', 125000],
    ['1,25,000', 125000],
    ['₹ 1,25,000', 125000],
    ['Rs. 99000.50', 99000.5],
    ['INR 5000', 5000],
    ['', null],
    ['   ', null],
  ])('reads %j as %j', (text, expected) => {
    expect(parseAmount(text)).toBe(expected);
  });

  it.each([['abc'], ['-500'], ['1.234'], ['12 000'], ['1e5'], ['100000000'], ['$500']])('refuses %j', (text) => {
    expect(parseAmount(text)).toBeUndefined();
  });
});

describe('parseMasterRows', () => {
  const header = ['University', 'City', 'Course', 'Level', 'Mode', 'CAF', 'Annual Fee', 'Duration'];
  const mapping = detectMasterMapping(header);
  const table = (...rows: string[][]) => ({ header, rows });

  it('finds the columns by their usual names', () => {
    expect(mapping).toEqual({ college: 0, city: 1, course: 2, level: 3, mode: 4, cafFee: 5, annualFee: 6, duration: 7 });
  });

  it('reads a good row, including words people use for level and mode', () => {
    const { rows, problems } = parseMasterRows(table(['Alpha University', 'Pune', 'B.Tech', 'Undergraduate', 'Offline', '1,500', '₹1,80,000', '4 years']), mapping);
    expect(problems).toEqual([]);
    expect(rows[0]).toMatchObject({ row: 2, college: 'Alpha University', city: 'Pune', course: 'B.Tech', level: 'UG', mode: 'regular', cafFee: 1500, annualFee: 180000, duration: 4 });
  });

  it('leaves optional cells empty as null', () => {
    const { rows } = parseMasterRows(table(['Beta', '', 'MBA', '', 'online', '', '', '']), mapping);
    expect(rows[0]).toMatchObject({ level: undefined, city: undefined, cafFee: null, annualFee: null, duration: null });
  });

  it('skips blank rows and numbers the rest as the spreadsheet does', () => {
    const { rows } = parseMasterRows(table(['A College', '', 'BBA', 'UG', 'both', '', '', ''], ['', '', '', '', '', '', '', ''], ['C College', '', 'BCA', 'UG', 'regular', '', '', '']), mapping);
    expect(rows.map((r) => r.row)).toEqual([2, 4]);
  });

  it('says what is wrong with each bad row, all at once', () => {
    const { rows, problems } = parseMasterRows(table(['X', '', '', 'Masters', 'sometimes', 'lots', '-1', '12'], ['Good College', '', 'BBA', 'UG', 'regular', '', '', '2.5']), mapping);
    expect(rows).toHaveLength(1);
    expect(problems).toHaveLength(1);
    const text = problems[0]!.problem;
    for (const word of ['college', 'course', 'mode', 'cafFee', 'annualFee', 'duration']) expect(text).toContain(word);
    expect(text).not.toContain('level'); // "Masters" is understood as PG
  });
});
