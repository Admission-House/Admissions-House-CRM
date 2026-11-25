import type { Env } from '../config/env.js';
import { UNIVERSAL_AI_LOCATIONS, UNIVERSAL_AI_PROGRAMS } from './universal-ai.data.js';

export interface PartnerProgram {
  campus: string;
  course: string;
  specializations: string[];
}

/** A college that takes a lead through its own API. What the college gave us is here; the secret key is not (it is read from the settings). */
export interface Partner {
  key: string;
  name: string;
  /** Where the college's API lives, unless the settings say otherwise. */
  defaultUrl: string;
  collegeId: string;
  source: string;
  programs: PartnerProgram[];
  /** state -> cities, exactly as the college lists them. */
  locations: Record<string, string[]>;
  /** Reads the secret key and address for this college from the settings. */
  credentials(env: Env): { secret: string | undefined; url: string };
}

/**
 * The dual specialization MBA. The document lists its Major and Minor options but not how to send both. The university said (20 Nov 2026)
 * that one specialization is enough: the aim is to pass on the student's email and number first, and the course can be changed later.
 * So it is offered with one specialization, any of the options the document names for either part, sent as that plain name.
 */
const UNIVERSAL_AI_DUAL: PartnerProgram = {
  campus: 'PG',
  course: 'MBA with Ai Dual Specialization (Major & Minor - any combination )',
  specializations: ['Business Analytics & AI', 'Marketing', 'Finance', 'Operations & Supply Chain'],
};

/** Universal AI University, through NoPaperForms. The values are the ones in its API document for this company. */
const UNIVERSAL_AI: Partner = {
  key: 'universal-ai',
  name: 'Universal AI University',
  defaultUrl: 'https://api.nopaperforms.com/dataporting/382/admissions_house',
  collegeId: '382',
  source: 'admissions_house',
  programs: [...UNIVERSAL_AI_PROGRAMS, UNIVERSAL_AI_DUAL],
  locations: UNIVERSAL_AI_LOCATIONS,
  credentials: (env) => ({
    secret: env.PARTNER_UAU_SECRET_KEY,
    url: env.PARTNER_UAU_URL ?? 'https://api.nopaperforms.com/dataporting/382/admissions_house',
  }),
};

export const PARTNERS: readonly Partner[] = [UNIVERSAL_AI];

export const partnerByKey = (key: string): Partner | undefined =>
  PARTNERS.find((p) => p.key === key);

/** The student's mobile as the college wants it: the ten digits, without the country code the CRM keeps in front. */
export function nationalMobile(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
}

export interface SendFields {
  course: string;
  specialization: string;
  state: string;
  city: string;
}

/**
 * Checks the choices against the college's own lists and returns the program's campus. Anything not on a list is refused here,
 * before a student's details leave the CRM, rather than being left for the college to reject.
 */
export function checkChoices(
  partner: Partner,
  f: SendFields,
): { campus: string } | { field: keyof SendFields; message: string } {
  const program = partner.programs.find((p) => p.course === f.course);
  if (!program) return { field: 'course', message: `${partner.name} does not offer this course` };
  if (!program.specializations.includes(f.specialization))
    return {
      field: 'specialization',
      message: 'This specialization is not offered with the chosen course',
    };
  const cities = partner.locations[f.state];
  if (!cities) return { field: 'state', message: `${partner.name} does not accept this state` };
  if (!cities.includes(f.city))
    return {
      field: 'city',
      message: "This city is not in the chosen state, on the college's list",
    };
  return { campus: program.campus };
}

export interface LeadFacts {
  name: string;
  email: string;
  phone: string;
  sourceName: string;
}

/** What is sent to the college. */
export function buildPayload(
  partner: Partner,
  secret: string,
  lead: LeadFacts,
  f: SendFields,
  campus: string,
): Record<string, string> {
  return {
    secret_key: secret,
    source: partner.source,
    college_id: partner.collegeId,
    name: lead.name,
    email: lead.email,
    mobile: nationalMobile(lead.phone),
    state: f.state,
    city: f.city,
    campus,
    course: f.course,
    specialization: f.specialization,
    // The document leaves these to us ("as per the publisher"): the channel is this CRM, and the campaign is where the lead came from.
    medium: 'CRM',
    campaign: lead.sourceName,
  };
}

/** The same payload without the secret, which is what is kept in the history. */
export const withoutSecret = (payload: Record<string, string>): Record<string, string> => {
  const { secret_key: _omitted, ...rest } = payload;
  void _omitted;
  return rest;
};

/** Reads the college's answer: accepted when the HTTP status is a success and the body does not say it failed. */
export function readAnswer(status: number, text: string): { ok: boolean; message: string } {
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON: judged by the HTTP status alone
  }
  const o = (body && typeof body === 'object' ? (body as Record<string, unknown>) : {}) as Record<
    string,
    unknown
  >;
  const said =
    typeof o.message === 'string' ? o.message : typeof o.error === 'string' ? o.error : '';
  const failed =
    o.status === false ||
    (typeof o.status === 'string' && /^(error|fail|failed|false)$/i.test(o.status)) ||
    (typeof o.error === 'string' && o.error !== '') ||
    o.success === false;
  const ok = status >= 200 && status < 300 && !failed;
  return {
    ok,
    message:
      said || (ok ? 'Accepted by the college' : `The college did not accept it (HTTP ${status})`),
  };
}
