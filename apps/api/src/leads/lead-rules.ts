import { AppError } from '../common/app-error.js';
import { normalizePhone } from '../common/phone.js';

// ----------------------------------------------------------------------- search

export type SearchTerm =
  | { kind: 'lead_no'; value: string }
  | { kind: 'phone'; value: string }
  | { kind: 'text'; value: string };

/**
 * Works out what a person typed in the search box.
 *   "1042", "#1042", "LEAD-1042"  a Lead ID
 *   "98765", "+91 98765 43210"    part of a phone number (8 or more digits)
 *   anything else                 a name or email
 * A short run of digits is a Lead ID, because no phone number is that short.
 */
export function classifySearch(raw: string): SearchTerm | null {
  const term = raw.trim();
  if (!term) return null;

  const leadNo = /^(?:#|lead[-\s]?)?(\d{1,7})$/i.exec(term);
  if (leadNo) return { kind: 'lead_no', value: String(Number(leadNo[1])) };

  const digits = term.replace(/[\s().+-]/g, '');
  if (/^\d{8,15}$/.test(digits)) {
    // A full Indian number is matched in its stored form (91XXXXXXXXXX); a fragment as typed.
    return { kind: 'phone', value: normalizePhone(term) ?? digits };
  }
  return { kind: 'text', value: term };
}

/** Escapes the characters that mean something in a LIKE pattern. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, '\\$&')}%`;
}

// -------------------------------------------------------------------- history

export interface FieldChange {
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

const show = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));

/**
 * What changed between two versions of a record, as history entries. Only fields that differ are
 * listed, and an empty value and a missing value count as the same thing.
 */
export function diffFields(before: Record<string, unknown>, after: Record<string, unknown>, fields: readonly string[]): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of fields) {
    if (!(field in after)) continue;
    const oldValue = show(before[field]);
    const newValue = show(after[field]);
    if (oldValue !== newValue) changes.push({ field, oldValue, newValue });
  }
  return changes;
}

// --------------------------------------------------------------------- status

export interface StatusRule {
  name: string;
  requiresFollowup: boolean;
  isOpen: boolean;
}

/**
 * A status that needs a follow-up cannot be set without one: either the request brings a date, or
 * the lead already has an open follow-up still to come.
 */
export function assertFollowUpForStatus(status: StatusRule, hasNewFollowUp: boolean, hasUpcomingFollowUp: boolean): void {
  if (status.requiresFollowup && status.isOpen && !hasNewFollowUp && !hasUpcomingFollowUp) {
    throw AppError.badRequest('FOLLOWUP_REQUIRED', `"${status.name}" needs the date and time of the next follow-up`, [
      { field: 'followUp', message: 'Give the date and time of the next follow-up' },
    ]);
  }
}

/** A follow-up cannot be set in the past; a minute of slack covers a slow clock or a slow request. */
export function assertFollowUpTime(dueAt: Date, now: Date = new Date()): void {
  if (dueAt.getTime() < now.getTime() - 60_000) {
    throw AppError.badRequest('FOLLOWUP_IN_PAST', 'The follow-up must be in the future', [
      { field: 'followUp.dueAt', message: 'Choose a date and time that has not passed' },
    ]);
  }
}
