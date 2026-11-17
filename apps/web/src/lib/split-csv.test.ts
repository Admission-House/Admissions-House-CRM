import { describe, expect, it } from 'vitest';
import { splitCsv } from './split-csv';

const sheet = (n: number) => ['Name,Phone', ...Array.from({ length: n }, (_v, i) => `Student ${i},98${String(10000000 + i)}`)].join('\n') + '\n';

describe('splitCsv', () => {
  it('keeps a small file as one part', () => {
    const r = splitCsv(sheet(3));
    expect(r.rows).toBe(3);
    expect(r.parts).toEqual([sheet(3)]);
  });

  it('cuts a large file into parts of at most the row limit, each with the heading row, losing no row', () => {
    const r = splitCsv(sheet(12_345), 5000);
    expect(r.rows).toBe(12_345);
    expect(r.parts).toHaveLength(3);
    expect(r.parts.map((p) => p.split('\n').length - 2)).toEqual([5000, 5000, 2345]);
    for (const p of r.parts) expect(p.startsWith('Name,Phone\n')).toBe(true);
    const names = r.parts.flatMap((p) => p.trim().split('\n').slice(1));
    expect(names).toHaveLength(12_345);
    expect(names[0]).toBe('Student 0,9810000000');
    expect(names.at(-1)).toBe('Student 12344,9810012344');
  });

  it('also cuts by size so a part always fits in one request', () => {
    const wide = ['Name,Notes', ...Array.from({ length: 20 }, (_v, i) => `S${i},${'x'.repeat(1000)}`)].join('\n');
    const r = splitCsv(wide, 5000, 5000);
    expect(r.parts.length).toBeGreaterThan(3);
    for (const p of r.parts) expect(p.length).toBeLessThan(6500);
    expect(r.parts.reduce((n, p) => n + p.trim().split('\n').length - 1, 0)).toBe(20);
  });

  it('never cuts a cell that contains a line break or a comma in quotes', () => {
    const text = 'Name,Notes\n"Riya, S",ok\n"Asha","line one\nline two"\nMeera,"say ""hi"""\n';
    const r = splitCsv(text, 1);
    expect(r.rows).toBe(3);
    expect(r.parts).toHaveLength(3);
    expect(r.parts[1]).toBe('Name,Notes\n"Asha","line one\nline two"\n');
    expect(r.parts[2]).toBe('Name,Notes\nMeera,"say ""hi"""\n');
  });

  it('handles Windows line breaks, a byte order mark, blank lines and a missing last line break', () => {
    const r = splitCsv('﻿Name,Phone\r\nA,1\r\n\r\nB,2');
    expect(r.rows).toBe(2);
    expect(r.parts).toEqual(['﻿Name,Phone\nA,1\nB,2\n']);
  });

  it('gives nothing for an empty file or a file with only headings', () => {
    expect(splitCsv('')).toEqual({ rows: 0, parts: [] });
    expect(splitCsv('Name,Phone\n')).toEqual({ rows: 0, parts: [] });
  });
});
