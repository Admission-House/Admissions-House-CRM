import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FieldError } from '../common/app-error.js';
import { normalizePhone } from '../common/phone.js';

// ---------------------------------------------------------------- reading a payload

/**
 * Text that may be missing or empty. Over-long text is cut to fit, not refused: a lead is worth
 * more than a perfectly tidy field.
 */
const text = (max: number) =>
  z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v.slice(0, max) : undefined));

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * What a lead source may send. The website's form sends exactly these fields; other sources send
 * the ones they have. Unknown fields are ignored (the raw payload is kept anyway).
 */
export const intakePayloadSchema = z.object({
  id: text(120),
  name: z.string().trim().min(1, 'A name is needed').transform((v) => v.slice(0, 80)),
  phone: z.string().trim().min(1, 'A phone number is needed').max(40),
  // A bad email must not cost us the lead: it is dropped instead.
  email: text(254).transform((v) => (v && EMAIL.test(v) ? v.toLowerCase() : undefined)),
  level: text(20).transform((v) => (v && /^(ug|pg|diploma)$/i.test(v) ? ({ ug: 'UG', pg: 'PG', diploma: 'Diploma' } as const)[v.toLowerCase() as 'ug' | 'pg' | 'diploma'] : undefined)),
  mode: text(20).transform((v) => (v && /^online$/i.test(v) ? ('online' as const) : v && /^regular$/i.test(v) ? ('regular' as const) : undefined)),
  stream: text(60),
  city: text(60),
  /** The course and college the student was looking at, as free text. */
  interest: text(300),
  /** Which form it came from, for example "home-popup". */
  source: text(60),
  page: text(300),
  utm: z
    .object({ source: text(100), medium: text(100), campaign: text(100), term: text(100), content: text(100) })
    .optional(),
});

export interface IntakeLead {
  name: string;
  /** Country code plus digits. */
  phone: string;
  email?: string;
  level?: 'UG' | 'PG' | 'Diploma';
  studyMode?: 'online' | 'regular';
  stream?: string;
  city?: string;
  interest?: string;
  formName?: string;
  pagePath?: string;
  utm: { source?: string; medium?: string; campaign?: string; term?: string; content?: string };
}

/** Words that mark a form as "download a brochure" until the company sets its own. */
export const DEFAULT_DOWNLOAD_FORMS = ['brochure', 'download'];

/** Does this form name mean the visitor asked to download something? Compared in lower case, by containing a keyword. */
export function isDownloadForm(formName: string | undefined, keywords: readonly string[]): boolean {
  if (!formName) return false;
  const name = formName.toLowerCase();
  return keywords.some((k) => k.trim() !== '' && name.includes(k.trim().toLowerCase()));
}

export type ParsedIntake = { ok: true; lead: IntakeLead } | { ok: false; errors: FieldError[] };

/** Turns whatever arrived into a clean lead, or says exactly what is wrong with it. */
export function parseIntake(raw: unknown): ParsedIntake {
  const parsed = intakePayloadSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => ({ field: i.path.join('.') || '(body)', message: i.message })) };
  }
  const p = parsed.data;
  const phone = normalizePhone(p.phone);
  if (!phone) return { ok: false, errors: [{ field: 'phone', message: 'This is not a valid mobile number' }] };

  return {
    ok: true,
    lead: {
      name: p.name,
      phone,
      email: p.email,
      level: p.level,
      studyMode: p.mode,
      stream: p.stream,
      city: p.city,
      interest: p.interest,
      formName: p.source,
      pagePath: p.page,
      utm: { ...p.utm },
    },
  };
}

/**
 * A note kept on the lead, for what could not be matched to the master lists (a city or stream the
 * company does not have yet), so that the counsellor still sees what the student asked for.
 */
export function interestNote(lead: IntakeLead, unmatched: { city: boolean; stream: boolean }): string | undefined {
  const parts = [
    lead.interest,
    unmatched.stream && lead.stream ? `Stream: ${lead.stream}` : undefined,
    unmatched.city && lead.city ? `City: ${lead.city}` : undefined,
  ].filter(Boolean);
  return parts.length ? parts.join(' | ') : undefined;
}

// ---------------------------------------------------------------- idempotency

/** JSON with keys in a fixed order, so the same content always gives the same text. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

const KEY = /^[\w.:@-]{1,120}$/;

/**
 * Names a delivery, so a retry of the same one is recognised. The sender's own key wins, then an id
 * inside the payload; with neither, the content itself identifies it, so an identical body sent
 * twice counts as one.
 */
export function deriveExternalId(headerKey: string | undefined, raw: unknown): string {
  if (headerKey && KEY.test(headerKey)) return headerKey;
  const bodyId = (raw as { id?: unknown } | null)?.id;
  if (typeof bodyId === 'string' && KEY.test(bodyId)) return bodyId;
  return `sha256:${createHash('sha256').update(stableStringify(raw)).digest('hex')}`;
}

// ---------------------------------------------------------------- assignment

export interface RuleLike {
  id: string;
  priority: number;
  sourceId: string | null;
  courseId: string | null;
  locationId: string | null;
  studyMode: 'online' | 'regular' | null;
  strategy: 'round_robin' | 'least_busy' | 'fixed';
}

export interface LeadFacts {
  sourceId: string;
  courseId: string | null;
  locationId: string | null;
  studyMode: 'online' | 'regular' | null;
}

/**
 * The first rule, lowest priority number first, whose conditions all hold. A condition left empty
 * means "any". A condition that is set never matches a lead that lacks that fact.
 */
export function firstMatchingRule<R extends RuleLike>(rules: readonly R[], lead: LeadFacts): R | undefined {
  return [...rules]
    .sort((a, b) => a.priority - b.priority)
    .find(
      (r) =>
        (r.sourceId === null || r.sourceId === lead.sourceId) &&
        (r.courseId === null || r.courseId === lead.courseId) &&
        (r.locationId === null || r.locationId === lead.locationId) &&
        (r.studyMode === null || r.studyMode === lead.studyMode),
    );
}

export interface Candidate {
  userId: string;
  /** When they were last given a lead; null if never. */
  lastAssignedAt: Date | null;
  openLeads: number;
}

const time = (c: Candidate): number => c.lastAssignedAt?.getTime() ?? Number.NEGATIVE_INFINITY;

/**
 * Picks who gets the lead.
 *   round_robin - whoever was given a lead longest ago (never, first), so turns rotate fairly.
 *   least_busy  - whoever has the fewest open leads, then the one who has waited longest.
 *   fixed       - always the same person: the first by id.
 * Ties break on id, so the choice is the same however the list arrives.
 */
export function pickAssignee(candidates: readonly Candidate[], strategy: RuleLike['strategy']): string | null {
  if (candidates.length === 0) return null;
  const byId = (a: Candidate, b: Candidate) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0);
  const sorted = [...candidates].sort((a, b) => {
    if (strategy === 'least_busy' && a.openLeads !== b.openLeads) return a.openLeads - b.openLeads;
    if (strategy !== 'fixed' && time(a) !== time(b)) return time(a) < time(b) ? -1 : 1;
    return byId(a, b);
  });
  return sorted[0]!.userId;
}
