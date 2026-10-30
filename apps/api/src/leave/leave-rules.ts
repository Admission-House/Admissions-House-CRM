import { AppError } from '../common/app-error.js';

const DAY_MS = 86_400_000;

/** A calendar date as a day number, so dates are compared and stepped without time zones. */
const dayNumber = (date: string): number => Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
const dateOf = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10);
const weekdayOf = (day: number): number => new Date(day * DAY_MS).getUTCDay(); // 0 = Sunday

export interface DayCountInput {
  from: string;
  to: string;
  /** Weekly days off, 0 = Sunday. */
  weeklyOff: readonly number[];
  holidays: ReadonlySet<string>;
  halfDay: boolean;
}

/**
 * The days of leave a request uses: the days from start to end that are working days. Weekly offs
 * and company holidays do not count, so taking a long weekend does not spend leave on the Sunday
 * or the holiday in between. A half day is one day only and counts as 0.5.
 */
export function countLeaveDays(input: DayCountInput): number {
  const start = dayNumber(input.from);
  const end = dayNumber(input.to);
  if (end < start) throw AppError.badRequest('DATES_REVERSED', 'The last day cannot be before the first day', [{ field: 'toDate', message: 'Choose a day on or after the first day' }]);
  if (input.halfDay && start !== end) {
    throw AppError.badRequest('HALF_DAY_SINGLE', 'A half day can be taken for one day only', [{ field: 'halfDay', message: 'Use a single day for a half day' }]);
  }
  let days = 0;
  for (let day = start; day <= end; day++) {
    if (!input.weeklyOff.includes(weekdayOf(day)) && !input.holidays.has(dateOf(day))) days++;
  }
  return input.halfDay ? days * 0.5 : days;
}

/** Leave balances are kept per calendar year, so one request stays inside one year. */
export function assertSingleYear(from: string, to: string): void {
  if (from.slice(0, 4) !== to.slice(0, 4)) {
    throw AppError.badRequest('SPANS_YEARS', 'Split leave that runs into the next year into two requests', [
      { field: 'toDate', message: 'Keep the leave within one calendar year' },
    ]);
  }
}

/** Remaining days after setting aside what is already waiting for a decision. */
export function availableDays(balance: number, pending: number): number {
  return Math.round((balance - pending) * 10) / 10;
}
