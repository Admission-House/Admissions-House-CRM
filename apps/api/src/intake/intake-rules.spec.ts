import { deriveExternalId, firstMatchingRule, interestNote, parseIntake, isDownloadForm, pickAssignee, RuleLike, stableStringify } from './intake-rules.js';

// The exact shape the Admissions House website sends.
const websitePayload = {
  id: '5b1d3a0e-7c9a-4f43-9d0b-0a1c2d3e4f50',
  createdAt: '2026-10-27T10:00:00.000Z',
  name: '  Riya Sharma ',
  phone: '9876543210',
  email: 'Riya@Example.com',
  level: 'UG',
  mode: 'Online',
  stream: 'Engineering',
  city: 'Noida',
  interest: 'B.Tech at XYZ University',
  source: 'home-popup',
  page: '/colleges/xyz',
  utm: { source: 'google', medium: 'cpc', campaign: 'btech-2026' },
};

describe('parseIntake', () => {
  it('reads what the website sends', () => {
    const r = parseIntake(websitePayload);
    expect(r).toEqual({
      ok: true,
      lead: {
        name: 'Riya Sharma', phone: '919876543210', email: 'riya@example.com', level: 'UG', studyMode: 'online',
        stream: 'Engineering', city: 'Noida', interest: 'B.Tech at XYZ University', formName: 'home-popup',
        pagePath: '/colleges/xyz', utm: { source: 'google', medium: 'cpc', campaign: 'btech-2026' },
      },
    });
  });

  it('accepts a bare minimum', () => {
    const r = parseIntake({ name: 'Asha', phone: '+91 98765 43210' });
    expect(r).toMatchObject({ ok: true, lead: { name: 'Asha', phone: '919876543210', utm: {} } });
  });

  it('keeps the lead when optional details are bad: a bad email, empty strings, an unknown mode', () => {
    const r = parseIntake({ ...websitePayload, email: 'not-an-email', stream: '', city: '   ', mode: 'Hybrid', level: 'PhD' });
    expect(r).toMatchObject({ ok: true, lead: { email: undefined, stream: undefined, city: undefined, studyMode: undefined, level: undefined } });
  });

  it('cuts over-long text instead of refusing the lead', () => {
    const r = parseIntake({ ...websitePayload, name: 'A'.repeat(200), interest: 'x'.repeat(1000) });
    expect(r.ok && r.lead.name).toHaveLength(80);
    expect(r.ok && r.lead.interest).toHaveLength(300);
  });

  it('ignores fields it does not know', () => {
    const r = parseIntake({ ...websitePayload, utm_term: 'x', somethingNew: { a: 1 } });
    expect(r.ok).toBe(true);
    expect(r.ok && Object.keys(r.lead)).not.toContain('somethingNew');
  });

  it.each([
    ['no name', { phone: '9876543210' }, 'name'],
    ['no phone', { name: 'Asha' }, 'phone'],
    ['a phone that is not a phone', { name: 'Asha', phone: '12345' }, 'phone'],
    ['a phone with letters', { name: 'Asha', phone: 'call me' }, 'phone'],
    ['a name of only spaces', { name: '   ', phone: '9876543210' }, 'name'],
  ])('says what is wrong with %s', (_n, payload, field) => {
    const r = parseIntake(payload);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.map((e) => e.field)).toContain(field);
  });

  it.each([null, undefined, 'text', 42, []])('refuses a body that is not an object: %j', (body) => {
    expect(parseIntake(body).ok).toBe(false);
  });
});

describe('interestNote', () => {
  const lead = (over = {}) => {
    const r = parseIntake({ ...websitePayload, ...over });
    if (!r.ok) throw new Error('bad test lead');
    return r.lead;
  };
  it('keeps the free text and adds only what could not be matched', () => {
    expect(interestNote(lead(), { city: false, stream: false })).toBe('B.Tech at XYZ University');
    expect(interestNote(lead(), { city: true, stream: true })).toBe('B.Tech at XYZ University | Stream: Engineering | City: Noida');
    expect(interestNote(lead({ interest: '', stream: '', city: '' }), { city: true, stream: true })).toBeUndefined();
  });
});

describe('deriveExternalId', () => {
  it('prefers the sender\'s idempotency key, then the payload id', () => {
    expect(deriveExternalId('abc-123', websitePayload)).toBe('abc-123');
    expect(deriveExternalId(undefined, websitePayload)).toBe(websitePayload.id);
  });

  it('ignores an unusable key and falls back to the content', () => {
    const id = deriveExternalId('bad key with spaces', { name: 'A', phone: '1' });
    expect(id).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('gives the same name to the same content however the keys are ordered, and different ones to different content', () => {
    const a = deriveExternalId(undefined, { name: 'A', phone: '1', utm: { x: 1, y: 2 } });
    const b = deriveExternalId(undefined, { utm: { y: 2, x: 1 }, phone: '1', name: 'A' });
    const c = deriveExternalId(undefined, { name: 'A', phone: '2' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('stableStringify handles nesting and arrays', () => {
    expect(stableStringify({ b: [1, { d: 1, c: 2 }], a: null })).toBe('{"a":null,"b":[1,{"c":2,"d":1}]}');
  });
});

describe('firstMatchingRule', () => {
  const rule = (over: Partial<RuleLike>): RuleLike => ({
    id: 'r', priority: 1, sourceId: null, courseId: null, locationId: null, studyMode: null, strategy: 'round_robin', ...over,
  });
  const lead = { sourceId: 'web', courseId: null, locationId: 'noida', studyMode: 'online' as const };

  it('takes the lowest priority number that matches, treating empty conditions as "any"', () => {
    const rules = [rule({ id: 'any', priority: 9 }), rule({ id: 'web-only', priority: 2, sourceId: 'web' }), rule({ id: 'ads', priority: 1, sourceId: 'ads' })];
    expect(firstMatchingRule(rules, lead)?.id).toBe('web-only');
  });

  it('requires every set condition to hold', () => {
    expect(firstMatchingRule([rule({ sourceId: 'web', studyMode: 'regular' })], lead)).toBeUndefined();
    expect(firstMatchingRule([rule({ sourceId: 'web', studyMode: 'online', locationId: 'noida' })], lead)).toBeDefined();
  });

  it('never matches a rule about a course for a lead that has no course', () => {
    expect(firstMatchingRule([rule({ courseId: 'btech' })], lead)).toBeUndefined();
    expect(firstMatchingRule([rule({ courseId: 'btech' })], { ...lead, courseId: 'btech' })).toBeDefined();
  });

  it('returns nothing when there are no rules', () => {
    expect(firstMatchingRule([], lead)).toBeUndefined();
  });
});

describe('pickAssignee', () => {
  const day = (n: number) => new Date(Date.UTC(2026, 9, n));
  const c = (userId: string, last: Date | null, openLeads = 0) => ({ userId, lastAssignedAt: last, openLeads });

  it('gives nobody when nobody is available', () => {
    expect(pickAssignee([], 'round_robin')).toBeNull();
  });

  it('round robin: someone who has never had a lead goes first, then whoever waited longest', () => {
    const people = [c('b', day(5)), c('a', day(3)), c('z', null)];
    expect(pickAssignee(people, 'round_robin')).toBe('z');
    expect(pickAssignee([c('b', day(5)), c('a', day(3))], 'round_robin')).toBe('a');
  });

  it('round robin rotates through everyone fairly', () => {
    const state = new Map<string, Date | null>([['a', null], ['b', null], ['c', null]]);
    const order: string[] = [];
    for (let i = 1; i <= 6; i++) {
      const next = pickAssignee([...state].map(([id, at]) => c(id, at)), 'round_robin')!;
      order.push(next);
      state.set(next, day(i));
    }
    expect(order).toEqual(['a', 'b', 'c', 'a', 'b', 'c']);
  });

  it('least busy: fewest open leads, then the one who waited longest', () => {
    expect(pickAssignee([c('a', day(1), 5), c('b', day(2), 2), c('c', day(3), 2)], 'least_busy')).toBe('b');
  });

  it('fixed: always the same person, whatever the history', () => {
    expect(pickAssignee([c('m', day(9)), c('k', day(1))], 'fixed')).toBe('k');
  });

  it('gives the same answer however the list is ordered', () => {
    const people = [c('a', day(2)), c('b', day(2)), c('c', day(2))];
    expect(pickAssignee(people, 'round_robin')).toBe(pickAssignee([...people].reverse(), 'round_robin'));
  });
});

describe('isDownloadForm', () => {
  it('matches a form whose name contains a keyword, whatever the case', () => {
    expect(isDownloadForm('detail-brochure', ['brochure', 'download'])).toBe(true);
    expect(isDownloadForm('Free-Guide-DOWNLOAD', ['download'])).toBe(true);
  });
  it('does not match other forms, an empty name or empty keywords', () => {
    expect(isDownloadForm('home-popup', ['brochure'])).toBe(false);
    expect(isDownloadForm(undefined, ['brochure'])).toBe(false);
    expect(isDownloadForm('detail-brochure', ['', '  '])).toBe(false);
    expect(isDownloadForm('detail-brochure', [])).toBe(false);
  });
});
