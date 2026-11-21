import { describe, expect, it } from 'vitest';
import { fmtMinutes } from './format';

describe('fmtMinutes', () => {
  it('reads like a person would say it', () => {
    expect(fmtMinutes(0)).toBe('0 min');
    expect(fmtMinutes(45)).toBe('45 min');
    expect(fmtMinutes(60)).toBe('1 h');
    expect(fmtMinutes(75)).toBe('1 h 15 min');
    expect(fmtMinutes(719)).toBe('11 h 59 min');
  });

  it('never shows a negative or a fraction', () => {
    expect(fmtMinutes(-5)).toBe('0 min');
    expect(fmtMinutes(14.6)).toBe('15 min');
  });
});
