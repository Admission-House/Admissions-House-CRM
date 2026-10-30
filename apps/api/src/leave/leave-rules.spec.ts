import { AppError } from '../common/app-error.js';
import { assertSingleYear, availableDays, countLeaveDays } from './leave-rules.js';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof AppError ? e.code : 'NOT_AN_APP_ERROR';
  }
  return undefined;
};

// 2026-10-26 is a Monday.
const base = { weeklyOff: [0], holidays: new Set<string>(), halfDay: false };

describe('countLeaveDays', () => {
  it('counts a single working day', () => {
    expect(countLeaveDays({ ...base, from: '2026-10-27', to: '2026-10-27' })).toBe(1);
  });

  it('counts a working week', () => {
    expect(countLeaveDays({ ...base, from: '2026-10-26', to: '2026-10-30' })).toBe(5);
  });

  it('does not spend leave on a Sunday inside the range', () => {
    // Friday to Tuesday: Fri, Sat, Mon, Tue are working days; Sunday is off.
    expect(countLeaveDays({ ...base, from: '2026-10-30', to: '2026-11-03' })).toBe(4);
  });

  it('counts nothing for a day that is entirely off', () => {
    expect(countLeaveDays({ ...base, from: '2026-11-01', to: '2026-11-01' })).toBe(0); // a Sunday
  });

  it('does not spend leave on a company holiday', () => {
    const holidays = new Set(['2026-10-29']);
    expect(countLeaveDays({ ...base, holidays, from: '2026-10-26', to: '2026-10-30' })).toBe(4);
  });

  it('follows the weekly offs the company has chosen', () => {
    expect(countLeaveDays({ ...base, weeklyOff: [0, 6], from: '2026-10-26', to: '2026-11-01' })).toBe(5);
    expect(countLeaveDays({ ...base, weeklyOff: [], from: '2026-10-26', to: '2026-11-01' })).toBe(7);
  });

  it('counts a half day as 0.5, but only for one day', () => {
    expect(countLeaveDays({ ...base, halfDay: true, from: '2026-10-27', to: '2026-10-27' })).toBe(0.5);
    expect(countLeaveDays({ ...base, halfDay: true, from: '2026-11-01', to: '2026-11-01' })).toBe(0);
    expect(codeOf(() => countLeaveDays({ ...base, halfDay: true, from: '2026-10-27', to: '2026-10-28' }))).toBe('HALF_DAY_SINGLE');
  });

  it('refuses dates the wrong way round', () => {
    expect(codeOf(() => countLeaveDays({ ...base, from: '2026-10-30', to: '2026-10-27' }))).toBe('DATES_REVERSED');
  });

  it('handles month ends, year ends and leap days without time-zone drift', () => {
    expect(countLeaveDays({ ...base, weeklyOff: [], from: '2026-12-30', to: '2026-12-31' })).toBe(2);
    expect(countLeaveDays({ ...base, weeklyOff: [], from: '2028-02-28', to: '2028-03-01' })).toBe(3); // 2028 is a leap year
    expect(countLeaveDays({ ...base, weeklyOff: [], from: '2026-02-27', to: '2026-03-02' })).toBe(4); // 2026 is not
  });
});

describe('assertSingleYear', () => {
  it('allows a range inside one year and refuses one across New Year', () => {
    expect(codeOf(() => assertSingleYear('2026-12-30', '2026-12-31'))).toBeUndefined();
    expect(codeOf(() => assertSingleYear('2026-12-30', '2027-01-02'))).toBe('SPANS_YEARS');
  });
});

describe('availableDays', () => {
  it('sets pending requests aside and avoids floating-point noise', () => {
    expect(availableDays(12, 2.5)).toBe(9.5);
    expect(availableDays(0.3, 0.1)).toBe(0.2);
    expect(availableDays(1, 1.5)).toBe(-0.5);
  });
});
