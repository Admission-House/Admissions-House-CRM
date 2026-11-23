import { describe, expect, it } from 'vitest';
import { readDate, readHolidaySheet } from './holiday-sheet';

describe('readDate', () => {
  it.each([
    ['25-12-2026', '2026-12-25'],
    ['25/12/2026', '2026-12-25'],
    ['25.12.2026', '2026-12-25'],
    ['5-1-2027', '2027-01-05'],
    ['2026-12-25', '2026-12-25'],
    ['25 Dec 2026', '2026-12-25'],
    ['25 December 2026', '2026-12-25'],
    ['1st Jan 2027', '2027-01-01'],
  ])('reads %s', (text, expected) => expect(readDate(text)).toBe(expected));

  it.each(['31-02-2026', '2026-13-01', 'Diwali', '12/2026', ''])('refuses %s', (text) => expect(readDate(text)).toBeNull());
});

describe('readHolidaySheet', () => {
  it('reads lines pasted from a sheet (tabs), skipping the heading', () => {
    const r = readHolidaySheet('Date\tHoliday\n25-12-2026\tChristmas\n26-01-2027\tRepublic Day\n');
    expect(r).toEqual([
      { line: 2, date: '2026-12-25', name: 'Christmas' },
      { line: 3, date: '2027-01-26', name: 'Republic Day' },
    ]);
  });

  it('reads a CSV with the name first and quotes', () => {
    const r = readHolidaySheet('"Diwali, main day",08/11/2026\nHoli,04-03-2027');
    expect(r).toEqual([
      { line: 1, date: '2026-11-08', name: 'Diwali, main day' },
      { line: 2, date: '2027-03-04', name: 'Holi' },
    ]);
  });

  it('marks lines it cannot use, and a date that appears twice', () => {
    const r = readHolidaySheet('25-12-2026,Christmas\nnot a holiday\n25-12-2026,Christmas again\n31-02-2026,Bad date\n01-01-2027,X');
    expect(r[0]).toEqual({ line: 1, date: '2026-12-25', name: 'Christmas' });
    expect(r[1]!.problem).toMatch(/No date/);
    expect(r[2]!.problem).toMatch(/Same date as line 1/);
    expect(r[3]!.problem).toMatch(/No date/);
    expect(r[4]!.problem).toMatch(/needs a name/);
  });
});
