import { describe, expect, it } from 'vitest';
import { homePath, START_PAGE_LABELS, START_PAGE_PATHS } from './start-page';

describe('homePath', () => {
  it('maps each chosen page to its address', () => {
    expect(homePath('leads')).toBe('/leads');
    expect(homePath('communications')).toBe('/communications');
  });
  it('falls back to the dashboard for nothing, or for anything that is not a known page', () => {
    expect(homePath(null)).toBe('/dashboard');
    expect(homePath(undefined)).toBe('/dashboard');
    expect(homePath('')).toBe('/dashboard');
    expect(homePath('https://evil.test')).toBe('/dashboard');
    expect(homePath('//evil.test')).toBe('/dashboard');
    expect(homePath('__proto__')).toBe('/dashboard');
    expect(homePath('constructor')).toBe('/dashboard');
  });
  it('has a label for every page', () => {
    expect(Object.keys(START_PAGE_LABELS).sort()).toEqual(Object.keys(START_PAGE_PATHS).sort());
  });
});
