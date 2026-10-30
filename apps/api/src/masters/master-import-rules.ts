import { normalizeHeader } from '../imports/import-rules.js';
import type { Table } from '../imports/spreadsheet.js';

export const FIELDS = ['college', 'city', 'state', 'course', 'level', 'stream', 'mode', 'cafFee', 'annualFee', 'duration'] as const;
export type MasterField = (typeof FIELDS)[number];
export type MasterMapping = Partial<Record<MasterField, number>>;

const SYNONYMS: Record<MasterField, string[]> = {
  college: ['college', 'collegename', 'university', 'universityname', 'institute', 'institutename', 'institution'],
  city: ['city', 'location', 'town'],
  state: ['state'],
  course: ['course', 'coursename', 'program', 'programme', 'programname'],
  level: ['level', 'courselevel', 'coursetype', 'ugpg'],
  stream: ['stream', 'field', 'discipline'],
  mode: ['mode', 'deliverymode', 'studymode', 'modeofstudy'],
  cafFee: ['caffee', 'caf', 'applicationfee', 'admissionfee', 'registrationfee'],
  annualFee: ['annualfee', 'fee', 'fees', 'yearlyfee', 'tuitionfee', 'feeperyear'],
  duration: ['duration', 'durationyears', 'years', 'courseduration'],
};

export function detectMasterMapping(header: readonly string[]): MasterMapping {
  const mapping: MasterMapping = {};
  const used = new Set<number>();
  for (const field of FIELDS) {
    const wanted = SYNONYMS[field].map(normalizeHeader);
    const at = header.findIndex((h, i) => !used.has(i) && wanted.includes(normalizeHeader(h)));
    if (at >= 0) {
      mapping[field] = at;
      used.add(at);
    }
  }
  return mapping;
}

export interface MasterRow {
  /** Row number in the spreadsheet, counting the header as row 1. */
  row: number;
  college: string;
  city?: string;
  state?: string;
  course: string;
  level?: 'UG' | 'PG' | 'Diploma';
  stream?: string;
  mode: 'online' | 'regular' | 'both';
  cafFee: number | null;
  annualFee: number | null;
  duration: number | null;
}

export interface MasterProblem {
  row: number;
  college?: string;
  course?: string;
  problem: string;
}

const LEVELS: Record<string, 'UG' | 'PG' | 'Diploma'> = {
  ug: 'UG', undergraduate: 'UG', bachelor: 'UG', bachelors: 'UG', pg: 'PG', postgraduate: 'PG', master: 'PG', masters: 'PG', diploma: 'Diploma',
};
const MODES: Record<string, MasterRow['mode']> = {
  online: 'online', distance: 'online', regular: 'regular', offline: 'regular', campus: 'regular', oncampus: 'regular', both: 'both', hybrid: 'both',
};

const key = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** A fee typed the way people type it: ₹1,25,000 or Rs. 125000.50. Returns undefined if it is not a plain amount. */
export function parseAmount(text: string): number | null | undefined {
  const t = text.trim();
  if (t === '') return null;
  const cleaned = t.replace(/^(?:₹|rs\.?|inr)\s*/i, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return undefined;
  const n = Number(cleaned);
  return n <= 99_999_999 ? n : undefined;
}

export function parseMasterRows(table: Table, mapping: MasterMapping): { rows: MasterRow[]; problems: MasterProblem[] } {
  const rows: MasterRow[] = [];
  const problems: MasterProblem[] = [];
  const cell = (cells: string[], f: MasterField) => (mapping[f] === undefined ? '' : (cells[mapping[f]!] ?? '').trim());

  table.rows.forEach((cells, i) => {
    const row = i + 2;
    const get = (f: MasterField) => cell(cells, f);
    if (FIELDS.every((f) => get(f) === '')) return;

    const college = get('college');
    const course = get('course');
    const fail: string[] = [];
    if (college.length < 2 || college.length > 150) fail.push('college: Give the college name (2 to 150 characters)');
    if (course.length < 2 || course.length > 100) fail.push('course: Give the course name (2 to 100 characters)');

    let level: MasterRow['level'];
    if (get('level')) {
      level = LEVELS[key(get('level'))];
      if (!level) fail.push('level: Use UG, PG or Diploma');
    }
    const mode = MODES[key(get('mode'))];
    if (!mode) fail.push('mode: Use online, regular or both');

    const cafFee = parseAmount(get('cafFee'));
    const annualFee = parseAmount(get('annualFee'));
    if (cafFee === undefined) fail.push('cafFee: Not a valid amount');
    if (annualFee === undefined) fail.push('annualFee: Not a valid amount');

    let duration: number | null = null;
    if (get('duration')) {
      const d = Number(get('duration').replace(/\s*(?:years?|yrs?)$/i, ''));
      if (Number.isFinite(d) && d >= 0.5 && d <= 10 && Math.round(d * 10) === d * 10) duration = d;
      else fail.push('duration: Use years between 0.5 and 10, such as 3 or 2.5');
    }

    if (fail.length > 0 || !mode) {
      problems.push({ row, college: college || undefined, course: course || undefined, problem: fail.join('; ') });
      return;
    }
    rows.push({
      row, college, course, level, mode, duration, cafFee: cafFee ?? null, annualFee: annualFee ?? null,
      city: get('city') || undefined, state: get('state') || undefined, stream: get('stream') || undefined,
    });
  });
  return { rows, problems };
}
