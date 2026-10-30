import { IntakeLead, parseIntake } from '../intake/intake-rules.js';
import type { Table } from './spreadsheet.js';

/** What a column of a lead spreadsheet can mean. */
export const FIELDS = ['name', 'phone', 'email', 'level', 'mode', 'stream', 'city', 'interest', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;
export type Field = (typeof FIELDS)[number];

/** Names people give these columns, written in lower case without spaces or marks. */
const SYNONYMS: Record<Field, string[]> = {
  name: ['name', 'fullname', 'studentname', 'leadname', 'candidatename', 'student', 'customername', 'naam', 'नाम'],
  phone: ['phone', 'mobile', 'mobilenumber', 'mobileno', 'phonenumber', 'phoneno', 'contact', 'contactnumber', 'contactno', 'whatsapp', 'whatsappnumber', 'cell', 'mob'],
  email: ['email', 'emailid', 'emailaddress', 'mail', 'mailid'],
  level: ['level', 'courselevel', 'programlevel', 'ugpg'],
  mode: ['mode', 'studymode', 'modeofstudy', 'coursemode', 'learningmode'],
  stream: ['stream', 'field', 'fieldofstudy', 'discipline'],
  city: ['city', 'location', 'preferredcity', 'currentcity', 'town'],
  interest: ['interest', 'course', 'coursename', 'program', 'programme', 'interestedin', 'interestedcourse', 'courseinterested'],
  utm_source: ['utmsource', 'campaignsource'],
  utm_medium: ['utmmedium', 'campaignmedium'],
  utm_campaign: ['utmcampaign', 'campaign', 'campaignname'],
  utm_term: ['utmterm', 'keyword'],
  utm_content: ['utmcontent', 'adcontent'],
};

export const normalizeHeader = (h: string): string => h.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '');

export type Mapping = Partial<Record<Field, number>>;

/**
 * Guesses which column is which from the header names. The first column that matches a field wins,
 * and a column is used once. Returns the headers that matched nothing too, so a person can fix them.
 */
export function detectMapping(header: readonly string[]): { mapping: Mapping; unmapped: string[] } {
  const mapping: Mapping = {};
  const used = new Set<number>();
  for (const field of FIELDS) {
    const wanted = SYNONYMS[field].map(normalizeHeader);
    const at = header.findIndex((h, i) => !used.has(i) && wanted.includes(normalizeHeader(h)));
    if (at >= 0) {
      mapping[field] = at;
      used.add(at);
    }
  }
  return { mapping, unmapped: header.filter((_h, i) => !used.has(i) && header[i] !== '') };
}

/** Lets a person say "the phone is in column Mobile No." when the guess is wrong or missing. */
export function applyColumnOverride<F extends string>(
  header: readonly string[], base: Partial<Record<F, number>>, override: Partial<Record<F, string>> | undefined, allowed: readonly F[],
): Partial<Record<F, number>> {
  const mapping = { ...base };
  for (const [field, columnName] of Object.entries(override ?? {}) as [F, string][]) {
    if (!allowed.includes(field)) continue;
    const at = header.findIndex((h) => h === columnName);
    if (at >= 0) mapping[field] = at;
  }
  return mapping;
}

export const applyOverride = (header: readonly string[], base: Mapping, override: Partial<Record<Field, string>> | undefined): Mapping =>
  applyColumnOverride(header, base, override, FIELDS);

export interface Record_ {
  /** Row number in the spreadsheet, counting the header as row 1. */
  row: number;
  raw: Partial<Record<Field, string>>;
}

/** The mapped cells of each non-empty row. */
export function toRecords(table: Table, mapping: Mapping): Record_[] {
  const out: Record_[] = [];
  table.rows.forEach((cells, i) => {
    const raw: Partial<Record<Field, string>> = {};
    for (const field of FIELDS) {
      const at = mapping[field];
      const value = at === undefined ? '' : (cells[at] ?? '').trim();
      if (value) raw[field] = value;
    }
    if (Object.keys(raw).length > 0) out.push({ row: i + 2, raw });
  });
  return out;
}

export interface ValidRow {
  row: number;
  lead: IntakeLead;
}

export interface InvalidRow {
  row: number;
  name?: string;
  phone?: string;
  problem: string;
}

/**
 * Applies the rules every lead goes through (the same as a lead from the website) to each row, and
 * sorts the rows into those that can be filed and those that cannot, with the reason.
 */
export function validateRecords(records: readonly Record_[], formName: string): { valid: ValidRow[]; invalid: InvalidRow[] } {
  const valid: ValidRow[] = [];
  const invalid: InvalidRow[] = [];
  for (const { row, raw } of records) {
    const missing = (['name', 'phone'] as const).filter((f) => !raw[f]);
    if (missing.length > 0) {
      invalid.push({ row, name: raw.name, phone: raw.phone, problem: missing.map((f) => `${f}: ${f === 'name' ? 'Name' : 'Phone number'} is required`).join('; ') });
      continue;
    }
    const parsed = parseIntake({
      name: raw.name, phone: raw.phone, email: raw.email, level: raw.level, mode: raw.mode, stream: raw.stream, city: raw.city,
      interest: raw.interest, source: formName,
      utm: { source: raw.utm_source, medium: raw.utm_medium, campaign: raw.utm_campaign, term: raw.utm_term, content: raw.utm_content },
    });
    if (parsed.ok) valid.push({ row, lead: parsed.lead });
    else invalid.push({ row, name: raw.name, phone: raw.phone, problem: parsed.errors.map((e) => `${e.field}: ${e.message}`).join('; ') });
  }
  return { valid, invalid };
}

/** How many of the valid rows repeat a phone number already seen earlier in the same file. */
export function repeatsInFile(valid: readonly ValidRow[]): number {
  const seen = new Set<string>();
  let repeats = 0;
  for (const { lead } of valid) {
    if (seen.has(lead.phone)) repeats++;
    seen.add(lead.phone);
  }
  return repeats;
}

