import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { startApp } from './helpers/app.js';
import { Client, makeClient } from './helpers/client.js';
import { createFixture, Fixture } from './helpers/fixtures.js';

let app: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;
let api: Client;
const t: Record<string, string> = {};
const ids: Record<string, string> = {}; // courses, institutes and what they offer

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  app = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500' });
  api = makeClient(app, fx);
  t.sa = await api.signIn('super');
  for (const name of ['admin', 'admin2', 'lc1', 'lc2']) t[name] = await api.signIn(name, { office: true });

  for (const [key, name, level] of [['btech', 'B.Tech', 'UG'], ['mba', 'MBA', 'PG']] as const) {
    ids[key] = (await api.call('POST', '/courses', t.sa!, { name, level })).json().id;
  }
  const make = async (key: string, name: string, courses: Record<string, unknown>[]) => {
    const res = await api.call('POST', '/colleges', t.sa!, { name, courses });
    expect(res.statusCode, res.body).toBe(201);
    ids[key] = res.json().id;
    for (const c of res.json().courses) ids[`${key}:${c.course.name}`] = c.id; // the id of "this course at this institute"
  };
  await make('alpha', 'Alpha University', [
    { courseId: ids.btech, deliveryMode: 'regular', cafFee: 1500, annualFee: 180000, durationYears: 4 },
    { courseId: ids.mba, deliveryMode: 'online', cafFee: 2000, annualFee: 120000, durationYears: 2 },
  ]);
  await make('beta', 'Beta Institute', [{ courseId: ids.btech, deliveryMode: 'online', annualFee: 90000, durationYears: 4 }]);
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.end();
});

// ------------------------------------------------------------------ helpers

let counter = 0;
const phone = () => `9${String(300_000_000 + ++counter).padStart(9, '0')}`;
const errorCode = (res: { json: () => { error?: { code?: string } } }) => res.json().error?.code;

async function lead(token = t.lc1!) {
  const res = await api.call('POST', '/leads', token, { name: 'Adm Lead', phone: phone(), sourceId: fx.sourceId('Website') });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string };
}
const shortlist = (token: string, leadId: string, collegeId: string, collegeCourseIds: string[] = []) =>
  api.call('POST', `/leads/${leadId}/shortlists`, token, { collegeId, collegeCourseIds });
const shortlists = async (token: string, leadId: string, view = 'all') => (await api.call('GET', `/leads/${leadId}/shortlists?view=${view}`, token)).json();
const history = async (token: string, leadId: string) =>
  (await api.call('GET', `/leads/${leadId}/activities?limit=100`, token)).json().items.filter((a: { type: string }) => a.type === 'shortlist') as {
    field: string; oldValue: string | null; newValue: string | null; remark: string | null;
  }[];
const url = (leadId: string, sid: string, tail = '') => `/leads/${leadId}/shortlists/${sid}${tail}`;

// =========================================================== recommendations

describe('recommending institutes', () => {
  it('lists what was recommended, by whom, and whether the student shortlisted it', async () => {
    const l = await lead();
    expect((await api.call('POST', `/leads/${l.id}/recommendations`, t.lc1!, { collegeId: ids.alpha })).statusCode).toBe(201);
    await api.call('POST', `/leads/${l.id}/recommendations`, t.lc1!, { collegeId: ids.beta });
    await shortlist(t.lc1!, l.id, ids.alpha!);

    const list = (await api.call('GET', `/leads/${l.id}/recommendations`, t.lc1!)).json();
    expect(list.map((r: { college: { name: string } }) => r.college.name).sort()).toEqual(['Alpha University', 'Beta Institute']);
    expect(list.find((r: { college: { name: string } }) => r.college.name === 'Alpha University')).toMatchObject({ recommendedBy: 'lc1', shortlisted: true });
    expect(list.find((r: { college: { name: string } }) => r.college.name === 'Beta Institute').shortlisted).toBe(false);
  });

  it('is not repeated, can be withdrawn, and is recorded', async () => {
    const l = await lead();
    await api.call('POST', `/leads/${l.id}/recommendations`, t.lc1!, { collegeId: ids.alpha });
    expect(errorCode(await api.call('POST', `/leads/${l.id}/recommendations`, t.lc1!, { collegeId: ids.alpha }))).toBe('ALREADY_RECOMMENDED');
    expect((await api.call('DELETE', `/leads/${l.id}/recommendations/${ids.alpha}`, t.lc1!)).statusCode).toBe(204);
    expect((await api.call('DELETE', `/leads/${l.id}/recommendations/${ids.alpha}`, t.lc1!)).statusCode).toBe(404);
    expect((await history(t.lc1!, l.id)).map((h) => `${h.field}:${h.oldValue ?? ''}>${h.newValue ?? ''}`)).toEqual([
      'recommended:Alpha University>', 'recommended:>Alpha University',
    ]);
  });

  it('only for an institute that exists and is in use', async () => {
    const l = await lead();
    expect(errorCode(await api.call('POST', `/leads/${l.id}/recommendations`, t.lc1!, { collegeId: '00000000-0000-4000-8000-000000000000' }))).toBe('COLLEGE_INVALID');
    const off = (await api.call('POST', '/colleges', t.sa!, { name: 'Closed Institute' })).json();
    await api.call('PATCH', `/colleges/${off.id}`, t.sa!, { isActive: false });
    expect(errorCode(await api.call('POST', `/leads/${l.id}/recommendations`, t.lc1!, { collegeId: off.id }))).toBe('COLLEGE_INVALID');
  });
});

// ============================================================== shortlisting

describe('shortlisting an institute', () => {
  it('starts a fresh application, with the courses and their fees read from the institute', async () => {
    const l = await lead();
    const res = await shortlist(t.lc1!, l.id, ids.alpha!, [ids['alpha:B.Tech']!, ids['alpha:MBA']!]);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({
      college: { name: 'Alpha University' }, formStatus: 'not_started', reconciliationStatus: 'not_sent',
      payment: { status: 'pending', amount: null, paidAt: null }, niDnp: null, shortlistedBy: 'lc1',
    });
    expect(res.json().courses).toEqual([
      expect.objectContaining({ course: expect.objectContaining({ name: 'B.Tech' }), deliveryMode: 'regular', cafFee: 1500, annualFee: 180000, durationYears: 4 }),
      expect.objectContaining({ course: expect.objectContaining({ name: 'MBA' }), deliveryMode: 'online', cafFee: 2000, annualFee: 120000, durationYears: 2 }),
    ]);

    // A fee is never copied: when the institute changes it, the shortlist shows the new one.
    await api.call('PUT', `/colleges/${ids.alpha}/courses/${ids.btech}`, t.sa!, { deliveryMode: 'regular', cafFee: 1800, annualFee: 190000, durationYears: 4 });
    const again = (await shortlists(t.lc1!, l.id))[0];
    expect(again.courses.find((c: { course: { name: string } }) => c.course.name === 'B.Tech')).toMatchObject({ cafFee: 1800, annualFee: 190000 });
    await api.call('PUT', `/colleges/${ids.alpha}/courses/${ids.btech}`, t.sa!, { deliveryMode: 'regular', cafFee: 1500, annualFee: 180000, durationYears: 4 });
  });

  it('is done once per institute, and says which one it is', async () => {
    const l = await lead();
    const first = await shortlist(t.lc1!, l.id, ids.alpha!);
    const again = await shortlist(t.lc1!, l.id, ids.alpha!);
    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe('ALREADY_SHORTLISTED');
    expect(again.json().error.details.shortlistId).toBe(first.json().id);
  });

  it('makes one shortlist when asked several times at once', async () => {
    const l = await lead();
    const results = await Promise.all(Array.from({ length: 4 }, () => shortlist(t.lc1!, l.id, ids.beta!)));
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409, 409, 409]);
    expect(await shortlists(t.lc1!, l.id)).toHaveLength(1);
  });

  it('accepts only courses that institute offers', async () => {
    const l = await lead();
    const res = await shortlist(t.lc1!, l.id, ids.beta!, [ids['alpha:MBA']!]);
    expect(res.statusCode).toBe(400);
    expect(errorCode(res)).toBe('COURSE_NOT_OFFERED');
    expect(await shortlists(t.lc1!, l.id)).toEqual([]); // nothing half-saved
    expect(errorCode(await shortlist(t.lc1!, l.id, '00000000-0000-4000-8000-000000000000'))).toBe('COLLEGE_INVALID');
  });

  it('can have its courses changed later', async () => {
    const l = await lead();
    const s = (await shortlist(t.lc1!, l.id, ids.alpha!, [ids['alpha:B.Tech']!])).json();
    const res = await api.call('PATCH', url(l.id, s.id), t.lc1!, { collegeCourseIds: [ids['alpha:MBA']!] });
    expect(res.json().courses.map((c: { course: { name: string } }) => c.course.name)).toEqual(['MBA']);
    expect((await api.call('PATCH', url(l.id, s.id), t.lc1!, { collegeCourseIds: [] })).json().courses).toEqual([]);
  });

  it('keeps an institute\'s offered course in place while a student has shortlisted it', async () => {
    const l = await lead();
    await shortlist(t.lc1!, l.id, ids.beta!, [ids['beta:B.Tech']!]);
    const res = await api.call('DELETE', `/colleges/${ids.beta}/courses/${ids.btech}`, t.sa!);
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('COURSE_IN_USE');
  });
});

// ================================================================ progress

describe('the progress of an application', () => {
  it('moves through the form and reconciliation steps, each change recorded', async () => {
    const l = await lead();
    const s = (await shortlist(t.lc1!, l.id, ids.alpha!)).json();
    const res = await api.call('PATCH', url(l.id, s.id), t.lc1!, { formStatus: 'filled', reconciliationStatus: 'mail_sent' });
    expect(res.json()).toMatchObject({ formStatus: 'filled', reconciliationStatus: 'mail_sent' });
    await api.call('PATCH', url(l.id, s.id), t.lc1!, { formStatus: 'submitted' });

    const log = (await history(t.lc1!, l.id)).filter((h) => h.field.endsWith('_status'));
    expect(log.map((h) => `${h.field}:${h.oldValue}>${h.newValue}`)).toEqual([
      'form_status:filled>submitted', 'reconciliation_status:not_sent>mail_sent', 'form_status:not_started>filled',
    ]);
    expect(log[0]!.remark).toBe('At Alpha University');
  });

  it('refuses a status that does not exist and an empty change', async () => {
    const l = await lead();
    const s = (await shortlist(t.lc1!, l.id, ids.alpha!)).json();
    expect(errorCode(await api.call('PATCH', url(l.id, s.id), t.lc1!, { formStatus: 'done' }))).toBe('VALIDATION_FAILED');
    expect(errorCode(await api.call('PATCH', url(l.id, s.id), t.lc1!, {}))).toBe('VALIDATION_FAILED');
  });
});

// ================================================================== payment

describe('the application fee', () => {
  it('is recorded with the amount and the date, can be corrected, and can be undone', async () => {
    const l = await lead();
    const s = (await shortlist(t.lc1!, l.id, ids.alpha!)).json();

    const paid = await api.call('PUT', url(l.id, s.id, '/payment'), t.lc1!, { amount: 1500, paidAt: '2026-10-20T10:30:00+05:30' });
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.json().payment).toMatchObject({ status: 'completed', amount: 1500 });
    expect(new Date(paid.json().payment.paidAt).toISOString()).toBe('2026-10-20T05:00:00.000Z');

    const fixed = await api.call('PUT', url(l.id, s.id, '/payment'), t.lc1!, { amount: 1800 });
    expect(fixed.json().payment).toMatchObject({ status: 'completed', amount: 1800 });
    expect(Date.now() - new Date(fixed.json().payment.paidAt).getTime()).toBeLessThan(60_000);

    const log = (await history(t.lc1!, l.id)).filter((h) => h.field === 'payment');
    expect(log.map((h) => `${h.oldValue}>${h.newValue}`)).toEqual(['1500>1800', 'null>1500']);

    const undone = await api.call('DELETE', url(l.id, s.id, '/payment'), t.lc1!);
    expect(undone.json().payment).toEqual({ status: 'pending', amount: null, paidAt: null });
    expect(errorCode(await api.call('DELETE', url(l.id, s.id, '/payment'), t.lc1!))).toBe('NO_PAYMENT');
  });

  it.each([
    ['a zero amount', { amount: 0 }],
    ['a negative amount', { amount: -100 }],
    ['text for an amount', { amount: 'a lot' }],
    ['a date in the future', { amount: 1500, paidAt: '2999-01-01T00:00:00Z' }],
    ['a date without a time zone', { amount: 1500, paidAt: '2026-10-20T10:30:00' }],
  ])('refuses %s', async (_n, body) => {
    const l = await lead();
    const s = (await shortlist(t.lc1!, l.id, ids.alpha!)).json();
    expect((await api.call('PUT', url(l.id, s.id, '/payment'), t.lc1!, body)).statusCode).toBe(400);
    expect((await shortlists(t.lc1!, l.id))[0].payment.status).toBe('pending');
  });

  it('keeps an institute with a payment from being removed', async () => {
    const l = await lead();
    const s = (await shortlist(t.lc1!, l.id, ids.alpha!)).json();
    await api.call('PUT', url(l.id, s.id, '/payment'), t.lc1!, { amount: 1500 });
    expect(errorCode(await api.call('DELETE', url(l.id, s.id), t.lc1!))).toBe('HAS_PAYMENT');
    await api.call('DELETE', url(l.id, s.id, '/payment'), t.lc1!);
    expect((await api.call('DELETE', url(l.id, s.id), t.lc1!)).statusCode).toBe(204);
    expect(await shortlists(t.lc1!, l.id)).toEqual([]);
    expect((await api.call('DELETE', url(l.id, s.id), t.lc1!)).statusCode).toBe(404);
  });
});

// ==================================================================== NI/DNP

describe('NI and DNP', () => {
  it('marks an institute with a reason, closes the application, and can be cleared', async () => {
    const l = await lead();
    const s = (await shortlist(t.lc1!, l.id, ids.alpha!)).json();
    expect(errorCode(await api.call('PUT', url(l.id, s.id, '/ni-dnp'), t.lc1!, { kind: 'ni' }))).toBe('VALIDATION_FAILED'); // a reason is needed
    expect(errorCode(await api.call('PUT', url(l.id, s.id, '/ni-dnp'), t.lc1!, { kind: 'maybe', reason: 'Not sure' }))).toBe('VALIDATION_FAILED');

    const marked = await api.call('PUT', url(l.id, s.id, '/ni-dnp'), t.lc1!, { kind: 'dnp', reason: 'Did not pick three times' });
    expect(marked.json().niDnp).toEqual({ kind: 'dnp', reason: 'Did not pick three times' });

    // While marked, the application cannot move on.
    expect(errorCode(await api.call('PATCH', url(l.id, s.id), t.lc1!, { formStatus: 'filled' }))).toBe('SHORTLIST_CLOSED');
    expect(errorCode(await api.call('PUT', url(l.id, s.id, '/payment'), t.lc1!, { amount: 1500 }))).toBe('SHORTLIST_CLOSED');

    const cleared = await api.call('DELETE', url(l.id, s.id, '/ni-dnp'), t.lc1!);
    expect(cleared.json().niDnp).toBeNull();
    expect(errorCode(await api.call('DELETE', url(l.id, s.id, '/ni-dnp'), t.lc1!))).toBe('NOT_MARKED');
    expect((await api.call('PATCH', url(l.id, s.id), t.lc1!, { formStatus: 'filled' })).statusCode).toBe(200);
    expect((await history(t.lc1!, l.id)).filter((h) => h.field === 'ni_dnp').map((h) => `${h.oldValue}>${h.newValue}`)).toEqual(['dnp>null', 'null>dnp']);
  });

  it('cannot be set once the fee is paid', async () => {
    const l = await lead();
    const s = (await shortlist(t.lc1!, l.id, ids.alpha!)).json();
    await api.call('PUT', url(l.id, s.id, '/payment'), t.lc1!, { amount: 1500 });
    expect(errorCode(await api.call('PUT', url(l.id, s.id, '/ni-dnp'), t.lc1!, { kind: 'ni', reason: 'Changed mind' }))).toBe('ALREADY_PAID');
  });
});

// ==================================================================== tabs

describe('the tabs of the lead page', () => {
  it('separate active, NI/DNP and reconciled institutes', async () => {
    const l = await lead();
    const a = (await shortlist(t.lc1!, l.id, ids.alpha!)).json();
    const b = (await shortlist(t.lc1!, l.id, ids.beta!)).json();
    await api.call('PATCH', url(l.id, a.id), t.lc1!, { reconciliationStatus: 'reconciled' });
    await api.call('PUT', url(l.id, b.id, '/ni-dnp'), t.lc1!, { kind: 'ni', reason: 'Too far' });

    const names = async (view: string) => (await shortlists(t.lc1!, l.id, view)).map((s: { college: { name: string } }) => s.college.name);
    expect(await names('all')).toEqual(['Alpha University', 'Beta Institute']);
    expect(await names('active')).toEqual(['Alpha University']);
    expect(await names('ni_dnp')).toEqual(['Beta Institute']);
    expect(await names('reconciled')).toEqual(['Alpha University']);
    expect(errorCode(await api.call('GET', `/leads/${l.id}/shortlists?view=other`, t.lc1!))).toBe('VALIDATION_FAILED');
  });
});

// ===================================================================== access

describe('who may work on an application', () => {
  it('follows who can see the lead', async () => {
    const l = await lead(t.lc1!);
    const s = (await shortlist(t.lc1!, l.id, ids.alpha!)).json();

    for (const [method, path, body] of [
      ['GET', `/leads/${l.id}/shortlists`, undefined],
      ['POST', `/leads/${l.id}/shortlists`, { collegeId: ids.beta }],
      ['PATCH', url(l.id, s.id), { formStatus: 'filled' }],
      ['PUT', url(l.id, s.id, '/payment'), { amount: 100 }],
      ['PUT', url(l.id, s.id, '/ni-dnp'), { kind: 'ni', reason: 'Not now' }],
      ['GET', `/leads/${l.id}/recommendations`, undefined],
    ] as const) {
      expect((await api.call(method, path, t.lc2!, body as never)).statusCode, `lc2 ${method} ${path}`).toBe(404);
      expect((await api.call(method, path, t.admin2!, body as never)).statusCode, `admin2 ${method} ${path}`).toBe(404);
    }
    expect((await api.call('PATCH', url(l.id, s.id), t.admin!, { formStatus: 'filled' })).statusCode).toBe(200); // the Admin of the team
    expect((await api.call('GET', `/leads/${l.id}/shortlists`, t.sa!)).statusCode).toBe(200);
  });

  it('a shortlist id from one lead does not work on another', async () => {
    const one = await lead();
    const other = await lead();
    const s = (await shortlist(t.lc1!, one.id, ids.alpha!)).json();
    expect((await api.call('PATCH', url(other.id, s.id), t.lc1!, { formStatus: 'filled' })).statusCode).toBe(404);
  });

  it('lets someone who may only read look but not change', async () => {
    const roleId = (await owner.query(`INSERT INTO roles (tenant_id, name, data_scope, requires_office) VALUES ($1, 'Looker', 'all', false) RETURNING id`, [fx.tenantId])).rows[0].id;
    await owner.query(`INSERT INTO role_permissions (tenant_id, role_id, permission_id) SELECT $1, $2, id FROM permissions WHERE code = 'lead.read'`, [fx.tenantId, roleId]);
    await fx.addUser({ name: 'looker', roleId });
    const looker = await api.signIn('looker');
    const l = await lead();
    expect((await api.call('GET', `/leads/${l.id}/shortlists`, looker)).statusCode).toBe(200);
    expect((await shortlist(looker, l.id, ids.alpha!)).statusCode).toBe(403);
  });
});
