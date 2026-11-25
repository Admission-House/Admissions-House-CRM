import { describe, expect, it } from 'vitest';
import {
  fromLocalValue,
  monthGrid,
  quickChoices,
  timeLabel,
  toLocalValue,
  TIME_SLOTS,
} from './date-picker';

describe('date picker arithmetic', () => {
  it('writes and reads the datetime-local format in local time', () => {
    const d = new Date(2026, 10, 25, 9, 5);
    expect(toLocalValue(d)).toBe('2026-11-25T09:05');
    expect(fromLocalValue('2026-11-25T09:05')!.getTime()).toBe(d.getTime());
    expect(fromLocalValue('25-11-2026')).toBeNull();
  });

  it('lays a month out in whole weeks, Monday first', () => {
    const g = monthGrid(2026, 10); // November 2026 starts on a Sunday
    expect(g.length % 7).toBe(0);
    expect(g[0]!.getDay()).toBe(1);
    expect(toLocalValue(g[6]!).slice(0, 10)).toBe('2026-11-01');
    expect(g.some((d) => d.getMonth() === 10 && d.getDate() === 30)).toBe(true);
  });

  it('offers half-hour times from 9 am to 8:30 pm, written the Indian way', () => {
    expect(TIME_SLOTS[0]).toBe('09:00');
    expect(TIME_SLOTS.at(-1)).toBe('20:30');
    expect(timeLabel('16:30')).toBe('4:30 pm');
    expect(timeLabel('12:00')).toBe('12:00 pm');
  });

  it('offers only quick choices still ahead', () => {
    const now = new Date(2026, 10, 24, 19, 10); // Tuesday 7:10 pm
    const q = quickChoices(now, now);
    expect(q.map((c) => c.label)).toEqual([
      'In 1 hour',
      'Tomorrow, 11 am',
      'Tomorrow, 4 pm',
      'Next Monday, 11 am',
    ]);
    expect(q[0]!.value).toBe('2026-11-24T20:10');
    expect(q.at(-1)!.value).toBe('2026-11-30T11:00');
  });
});
