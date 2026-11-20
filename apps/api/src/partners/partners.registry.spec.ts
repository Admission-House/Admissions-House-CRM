import { buildPayload, checkChoices, nationalMobile, partnerByKey, PARTNERS, readAnswer, withoutSecret } from './partners.registry.js';

const uau = partnerByKey('universal-ai')!;
const ok = { course: 'MBA Single Specialization', specialization: 'Marketing', state: 'Delhi', city: 'Central Delhi' };

describe("the college's own lists", () => {
  it('are loaded in full from its document', () => {
    expect(uau.programs.length).toBe(7);
    expect(uau.programs.flatMap((p) => p.specializations)).toHaveLength(18);
    expect(Object.keys(uau.locations)).toHaveLength(37);
    expect(Object.values(uau.locations).flat()).toHaveLength(7552);
    for (const p of uau.programs) expect(p.specializations.length).toBeGreaterThan(0);
    for (const [state, cities] of Object.entries(uau.locations)) expect(cities.length, state).toBeGreaterThan(0);
  });

  it('offer the dual specialization course with one specialization, as the university asked', () => {
    const dual = uau.programs.find((p) => /dual/i.test(p.course))!;
    expect(dual.course).toBe('MBA with Ai Dual Specialization (Major & Minor - any combination )');
    expect(dual.specializations).toEqual(['Business Analytics & AI', 'Marketing', 'Finance', 'Operations & Supply Chain']);
    expect(checkChoices(uau, { course: dual.course, specialization: 'Finance', state: 'Delhi', city: 'Central Delhi' })).toEqual({ campus: 'PG' });
  });

  it('have one entry per key', () => {
    expect(new Set(PARTNERS.map((p) => p.key)).size).toBe(PARTNERS.length);
  });
});

describe('nationalMobile', () => {
  it('drops the country code the CRM keeps in front', () => {
    expect(nationalMobile('919876543210')).toBe('9876543210');
    expect(nationalMobile('9876543210')).toBe('9876543210');
    expect(nationalMobile('+91 98765 43210')).toBe('9876543210');
  });
  it('leaves other lengths alone', () => {
    expect(nationalMobile('447911123456')).toBe('447911123456');
  });
});

describe('checkChoices', () => {
  it('accepts a course, a specialization of it, and a state with one of its cities, and returns the campus', () => {
    const state = Object.keys(uau.locations)[0]!;
    const city = uau.locations[state]![0]!;
    expect(checkChoices(uau, { ...ok, state, city })).toEqual({ campus: 'PG' });
  });
  it('refuses a course the college does not offer', () => {
    expect(checkChoices(uau, { ...ok, course: 'B.Tech' })).toMatchObject({ field: 'course' });
  });
  it('refuses a specialization that belongs to a different course', () => {
    expect(checkChoices(uau, { ...ok, specialization: 'International Business' })).toMatchObject({ field: 'specialization' });
  });
  it('refuses an unknown state, and a city that is not in the chosen state', () => {
    expect(checkChoices(uau, { ...ok, state: 'Atlantis', city: 'x' })).toMatchObject({ field: 'state' });
    const [first, second] = Object.keys(uau.locations);
    const cityOfSecond = uau.locations[second!]![0]!;
    expect(checkChoices(uau, { ...ok, state: first!, city: cityOfSecond })).toMatchObject({ field: 'city' });
  });
});

describe('buildPayload', () => {
  const lead = { name: 'Asha Verma', email: 'asha@example.com', phone: '919876543210', sourceName: 'Google Ads' };
  const state = Object.keys(uau.locations)[0]!;
  const city = uau.locations[state]![0]!;
  const payload = buildPayload(uau, 'SECRET-123456', lead, { ...ok, state, city }, 'PG');

  it('carries exactly the fields in the college document', () => {
    expect(Object.keys(payload).sort()).toEqual(['campaign', 'campus', 'city', 'college_id', 'course', 'email', 'medium', 'mobile', 'name', 'secret_key', 'source', 'specialization', 'state']);
    expect(payload).toMatchObject({ source: 'admissions_house', college_id: '382', name: 'Asha Verma', email: 'asha@example.com', mobile: '9876543210', campus: 'PG', medium: 'CRM', campaign: 'Google Ads' });
  });

  it('keeps the secret out of what is stored', () => {
    const kept = withoutSecret(payload);
    expect(kept).not.toHaveProperty('secret_key');
    expect(JSON.stringify(kept)).not.toContain('SECRET-123456');
  });
});

describe('readAnswer', () => {
  it('accepts a success status and a body that does not say it failed', () => {
    expect(readAnswer(200, '{"status":true,"message":"Lead created"}')).toEqual({ ok: true, message: 'Lead created' });
    expect(readAnswer(200, 'OK')).toMatchObject({ ok: true });
    expect(readAnswer(201, '')).toMatchObject({ ok: true });
  });
  it('refuses a body that says it failed, even with a 200', () => {
    expect(readAnswer(200, '{"status":false,"message":"Duplicate lead"}')).toEqual({ ok: false, message: 'Duplicate lead' });
    expect(readAnswer(200, '{"status":"error","message":"Bad mobile"}')).toMatchObject({ ok: false });
    expect(readAnswer(200, '{"error":"Invalid secret"}')).toEqual({ ok: false, message: 'Invalid secret' });
    expect(readAnswer(200, '{"success":false}')).toMatchObject({ ok: false });
  });
  it('refuses an error status and says which', () => {
    expect(readAnswer(401, '{}')).toEqual({ ok: false, message: 'The college did not accept it (HTTP 401)' });
    expect(readAnswer(500, 'oops')).toMatchObject({ ok: false });
  });
});
