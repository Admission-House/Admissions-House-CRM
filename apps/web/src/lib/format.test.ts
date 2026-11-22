import { describe, expect, it } from 'vitest';
import { firstName, fmtMinutes, greeting } from './format';

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

describe('greeting', () => {
  const at = (h: number, m = 0) => new Date(2026, 10, 23, h, m);
  it('follows the time of day on the viewer\'s own clock', () => {
    expect(greeting(at(4))).toBe('Good morning');
    expect(greeting(at(9, 30))).toBe('Good morning');
    expect(greeting(at(11, 59))).toBe('Good morning');
    expect(greeting(at(12))).toBe('Good afternoon');
    expect(greeting(at(16, 59))).toBe('Good afternoon');
    expect(greeting(at(17))).toBe('Good evening');
    expect(greeting(at(23, 30))).toBe('Good evening');
    expect(greeting(at(2))).toBe('Good evening');
  });

  it('greets a person by their first name', () => {
    expect(firstName('Riya Sharma')).toBe('Riya');
    expect(firstName('  Khushi  ')).toBe('Khushi');
  });
});
