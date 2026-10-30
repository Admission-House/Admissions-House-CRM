import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { startApp } from './helpers/app.js';
import { Client, makeClient } from './helpers/client.js';
import { createFixture, Fixture } from './helpers/fixtures.js';

let app: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;
let api: Client;
const t: Record<string, string> = {}; // signed-in tokens by name

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  app = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500' });
  api = makeClient(app, fx);
  t.sa = await api.signIn('super');
  for (const name of ['admin', 'admin2', 'lc1', 'lc2', 'lc3', 'counsellor2']) t[name] = await api.signIn(name, { office: true });
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.end();
});

// ------------------------------------------------------------------ helpers

let counter = 0;
const phone = () => `9${String(700_000_000 + ++counter).padStart(9, '0')}`;
const errorCode = (res: { json: () => { error?: { code?: string } } }) => res.json().error?.code;
const idOf = (name: string) => fx.user(name).id;
const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

const statusId = async (name: string) =>
  (await owner.query(`SELECT id FROM lead_statuses WHERE tenant_id = $1 AND name = $2`, [fx.tenantId, name])).rows[0].id as string;

const create = (token: string, over: Record<string, unknown> = {}) =>
  api.call('POST', '/leads', token, { name: 'Test Lead', phone: phone(), sourceId: fx.sourceId('Website'), ...over });

/** Creates a lead and returns its detail. */
async function lead(token: string, over: Record<string, unknown> = {}) {
  const res = await create(token, over);
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

/** Every lead a person can see for a query, following the pages. */
async function everything(token: string, query = ''): Promise<{ id: string }[]> {
  const out: { id: string }[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const res = await api.call('GET', `/leads?limit=50${query ? `&${query}` : ''}${cursor ? `&cursor=${cursor}` : ''}`, token);
    expect(res.statusCode, res.body).toBe(200);
    out.push(...res.json().items);
    cursor = res.json().nextCursor;
    pages++;
  } while (cursor && pages < 40);
  return out;
}

const activities = async (token: string, id: string) => (await api.call('GET', `/leads/${id}/activities?limit=100`, token)).json().items as {
  type: string; field: string | null; oldValue: string | null; newValue: string | null; remark: string | null; user: { name: string } | null;
}[];

const row = async (id: string) => (await owner.query(`SELECT * FROM leads WHERE id = $1`, [id])).rows[0];

// ==================================================================== create

describe('adding a lead by hand', () => {
  it('gives it to the person who added it, in the first status, with a Lead ID and a history', async () => {
    const res = await create(t.lc1!, {
      name: '  Riya Sharma ', phone: '+91 98765 11111', email: 'Riya@Example.com', studyMode: 'online', intent: 'hot',
      expectedClosureOn: '2026-12-15', note: 'Called back after the fair', followUp: { dueAt: inAnHour(), note: 'Send brochure' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const l = res.json();
    expect(l).toMatchObject({
      name: 'Riya Sharma', phone: '919876511111', email: 'riya@example.com', studyMode: 'online', intent: 'hot',
      expectedClosureOn: '2026-12-15', status: { name: 'New', queue: 'fresh' }, queue: 'fresh', source: { name: 'Website' },
      assignedTo: { name: 'lc1' }, createdBy: 'lc1', openFollowUps: 1,
    });
    expect(Number(l.leadNo)).toBeGreaterThan(0);
    expect(l.nextFollowupAt).not.toBeNull();

    const types = (await activities(t.lc1!, l.id)).map((a) => a.type).sort();
    expect(types).toEqual(['assignment', 'enquiry', 'followup', 'note']);
  });

  it('numbers leads one after another', async () => {
    const a = await lead(t.lc1!);
    const b = await lead(t.lc1!);
    expect(Number(b.leadNo)).toBe(Number(a.leadNo) + 1);
  });

  it('warns about a phone number that already has a lead, and says which', async () => {
    const first = await lead(t.lc1!, { phone: '9876522222' });
    const res = await create(t.lc2!, { phone: '+91 98765-22222' });
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('DUPLICATE_LEAD');
    expect(res.json().error.details.existing).toMatchObject({ id: first.id, leadNo: first.leadNo, assignedTo: 'lc1' });
  });

  it.each([
    ['a phone that is not a number', { phone: '12345' }, 'VALIDATION_FAILED'],
    ['a lead source that does not exist', { sourceId: '00000000-0000-4000-8000-000000000000' }, 'SOURCE_INVALID'],
    ['a follow-up in the past', { followUp: { dueAt: '2020-01-01T10:00:00Z' } }, 'FOLLOWUP_IN_PAST'],
    ['a course that does not exist', { interestedCourseId: '00000000-0000-4000-8000-000000000000' }, 'REFERENCE_INVALID'],
    ['an email that is not an email', { email: 'nope' }, 'VALIDATION_FAILED'],
    ['a name that is too short', { name: 'A' }, 'VALIDATION_FAILED'],
  ])('refuses %s', async (_n, over, code) => {
    const res = await create(t.lc1!, over);
    expect(res.statusCode, res.body).toBe(400);
    expect(errorCode(res)).toBe(code);
  });

  describe('by someone who hands out leads', () => {
    it('gives it to the person they name, or to nobody', async () => {
      const named = await lead(t.admin!, { assignTo: idOf('lc2') });
      expect(named.assignedTo).toMatchObject({ name: 'lc2' });

      const nobody = await lead(t.admin!, { assignTo: null });
      expect(nobody.assignedTo).toBeNull();
      expect((await row(nobody.id)).assigned_at).toBeNull();
    });

    it('refuses someone outside their team, or someone who does not work with leads', async () => {
      expect(errorCode(await create(t.admin!, { assignTo: idOf('counsellor2') }))).toBe('ASSIGNEE_INVALID');
      expect(errorCode(await create(t.admin!, { assignTo: idOf('super') }))).toBe('ASSIGNEE_INVALID');
    });

    it('lets a Super Admin give a lead to anyone', async () => {
      expect((await lead(t.sa!, { assignTo: idOf('counsellor2') })).assignedTo).toMatchObject({ name: 'counsellor2' });
    });
  });
});

// ================================================================ visibility

describe('who can see which lead', () => {
  let mine: { id: string }; // lc1's
  let others: { id: string }; // lc2's
  let foreign: { id: string }; // counsellor2's, under the other Admin
  let pool: { id: string }; // unassigned

  beforeAll(async () => {
    mine = await lead(t.lc1!, { name: 'Vis Mine' });
    others = await lead(t.lc2!, { name: 'Vis Other' });
    foreign = await lead(t.counsellor2!, { name: 'Vis Foreign' });
    pool = await lead(t.admin!, { name: 'Vis Pool', assignTo: null });
  });

  const canSee = async (token: string, id: string) => (await api.call('GET', `/leads/${id}`, token)).statusCode === 200;

  it('shows a counsellor only their own leads', async () => {
    expect(await canSee(t.lc1!, mine.id)).toBe(true);
    expect(await canSee(t.lc1!, others.id)).toBe(false);
    expect(await canSee(t.lc1!, pool.id)).toBe(false);
    const ids = (await everything(t.lc1!)).map((l) => l.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(others.id);
    expect(ids).not.toContain(pool.id);
  });

  it('shows an Admin their team and the unassigned leads, never another Admin\'s team', async () => {
    expect(await canSee(t.admin!, mine.id)).toBe(true);
    expect(await canSee(t.admin!, others.id)).toBe(true);
    expect(await canSee(t.admin!, pool.id)).toBe(true);
    expect(await canSee(t.admin!, foreign.id)).toBe(false);
    expect(await canSee(t.admin2!, mine.id)).toBe(false);
    expect(await canSee(t.admin2!, foreign.id)).toBe(true);
    expect(await canSee(t.admin2!, pool.id)).toBe(true);
  });

  it('shows a Super Admin everything', async () => {
    for (const l of [mine, others, foreign, pool]) expect(await canSee(t.sa!, l.id)).toBe(true);
  });

  it('answers "not found" for a lead that is hidden, never "forbidden"', async () => {
    const res = await api.call('GET', `/leads/${others.id}`, t.lc1!);
    expect(res.statusCode).toBe(404);
    expect(errorCode(res)).toBe('NOT_FOUND');
    for (const [method, path] of [['PATCH', ''], ['POST', '/status'], ['POST', '/notes'], ['GET', '/activities']] as const) {
      const r = await api.call(method, `/leads/${others.id}${path}`, t.lc1!, method === 'GET' ? undefined : { name: 'x y', statusId: await statusId('Contacted'), remark: 'x' });
      expect(r.statusCode, `${method} ${path}`).toBe(404);
    }
  });

  it('does not show another company\'s leads', async () => {
    const solo = await createFixture(owner, [{ name: 'only', role: 'super_admin' }]);
    try {
      const soloApp = makeClient(app, solo);
      const token = await soloApp.signIn('only');
      expect((await soloApp.call('GET', '/leads', token)).json().items).toEqual([]);
      expect((await soloApp.call('GET', `/leads/${mine.id}`, token)).statusCode).toBe(404);
    } finally {
      await solo.cleanup();
    }
  });
});

// ======================================================================= list

describe('the lead list', () => {
  const ids: Record<string, string> = {};
  let q1: string;

  beforeAll(async () => {
    q1 = phone();
    const a = await lead(t.lc3!, { name: 'Zeenat Alvi', phone: q1, email: 'zeenat@searchme.test', intent: 'hot', studyMode: 'online', sourceId: fx.sourceId('Meta Ads') });
    const b = await lead(t.lc3!, { name: 'Yusuf Bhat', intent: 'cold', studyMode: 'regular', followUp: { dueAt: inAnHour() } });
    const c = await lead(t.lc3!, { name: 'Xena Rao', intent: 'warm' });
    Object.assign(ids, { a: a.id, b: b.id, c: c.id });
    ids.aNo = a.leadNo;
  });

  it('finds leads by name, email, phone, part of a phone and Lead ID', async () => {
    const find = async (term: string) => (await everything(t.lc3!, `q=${encodeURIComponent(term)}`)).map((l) => l.id);
    expect(await find('zeenat')).toEqual([ids.a]);
    expect(await find('searchme.test')).toEqual([ids.a]);
    expect(await find(q1)).toEqual([ids.a]);
    expect(await find(`+91 ${q1.slice(0, 5)} ${q1.slice(5)}`)).toEqual([ids.a]);
    expect(await find(q1.slice(-8))).toContain(ids.a);
    expect(await find(`#${ids.aNo}`)).toEqual([ids.a]);
    expect(await find('nobody-has-this-name')).toEqual([]);
    expect(await find('%')).toEqual([]); // wildcards are not wildcards
  });

  it('filters by status, source, intent, study mode and owner', async () => {
    const only = async (query: string) => (await everything(t.lc3!, query)).map((l) => l.id);
    expect(await only(`sourceId=${fx.sourceId('Meta Ads')}`)).toEqual([ids.a]);
    expect(await only('intent=cold')).toEqual([ids.b]);
    expect(await only('studyMode=regular')).toEqual([ids.b]);
    expect((await only('assignedTo=me')).length).toBeGreaterThanOrEqual(3);
    expect(await only('assignedTo=unassigned')).toEqual([]); // a counsellor never sees the pool
    expect((await only(`statusId=${await statusId('New')}`)).sort()).toEqual([ids.a, ids.b, ids.c].sort());
    expect(await only(`statusId=${await statusId('Counselled')}`)).toEqual([]);
  });

  it('lets an Admin list the pool and one person\'s leads', async () => {
    const pool = await lead(t.admin!, { assignTo: null });
    const unassigned = (await everything(t.admin!, 'assignedTo=unassigned')).map((l) => l.id);
    expect(unassigned).toContain(pool.id);
    const lc3Only = (await everything(t.admin!, `assignedTo=${idOf('lc3')}`)).map((l) => l.id);
    expect(lc3Only).toEqual(expect.arrayContaining([ids.a, ids.b, ids.c]));
  });

  it('filters by the day the lead was added, and by follow-up', async () => {
    const today = (await owner.query(`SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`)).rows[0].d;
    const tomorrow = (await owner.query(`SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date + 1)::text AS d`)).rows[0].d;
    const todays = (await everything(t.lc3!, `createdFrom=${today}&createdTo=${today}`)).map((l) => l.id);
    expect(todays).toEqual(expect.arrayContaining([ids.a, ids.b, ids.c]));
    expect(await everything(t.lc3!, `createdFrom=${tomorrow}`)).toEqual([]);

    // b has a follow-up within the hour: overdue or today depending on the clock, but never upcoming-tomorrow.
    await owner.query(`UPDATE leads SET next_followup_at = now() - interval '2 hours' WHERE id = $1`, [ids.b]);
    expect((await everything(t.lc3!, 'followup=overdue')).map((l) => l.id)).toEqual([ids.b]);
    await owner.query(`UPDATE leads SET next_followup_at = now() + interval '3 days' WHERE id = $1`, [ids.b]);
    expect((await everything(t.lc3!, 'followup=upcoming')).map((l) => l.id)).toEqual([ids.b]);
    expect(await everything(t.lc3!, 'followup=overdue')).toEqual([]);
  });

  it.each(['newest', 'updated', 'followup'])('pages through everything exactly once when sorted by %s', async (sort) => {
    const seen = (await everything(t.sa!, `sort=${sort}`)).map((l) => l.id);
    expect(new Set(seen).size).toBe(seen.length);
    const total = Number((await owner.query(`SELECT count(*) FROM leads WHERE tenant_id = $1 AND deleted_at IS NULL`, [fx.tenantId])).rows[0].count);
    expect(seen.length).toBe(total);
  });

  it('orders by newest, and by follow-up with the soonest first and leads without one last', async () => {
    const newest = await api.call('GET', '/leads?limit=100&sort=newest', t.sa!);
    const times = newest.json().items.map((l: { createdAt: string }) => Date.parse(l.createdAt));
    expect(times).toEqual([...times].sort((x, y) => y - x));

    const byFollowup = await api.call('GET', '/leads?limit=100&sort=followup', t.sa!);
    const due = byFollowup.json().items.map((l: { nextFollowupAt: string | null }) => (l.nextFollowupAt ? Date.parse(l.nextFollowupAt) : Infinity));
    expect(due).toEqual([...due].sort((x, y) => x - y));
  });

  it('refuses a damaged page marker and an oversized page', async () => {
    expect(errorCode(await api.call('GET', '/leads?cursor=forged', t.sa!))).toBe('INVALID_CURSOR');
    expect(errorCode(await api.call('GET', '/leads?limit=500', t.sa!))).toBe('VALIDATION_FAILED');
    expect(errorCode(await api.call('GET', '/leads?queue=nonsense', t.sa!))).toBe('VALIDATION_FAILED');
  });
});

// ===================================================================== queues

describe('queues', () => {
  it('count every lead exactly once', async () => {
    const q = (await api.call('GET', '/leads/queues', t.sa!)).json();
    const total = Number((await owner.query(`SELECT count(*) FROM leads WHERE tenant_id = $1 AND deleted_at IS NULL`, [fx.tenantId])).rows[0].count);
    expect(q.total).toBe(total);
    expect(Object.values(q.queues as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(total);
    expect(Object.keys(q.queues).sort()).toEqual(['closed', 'counselled', 'fee_paid', 'followup', 'fresh', 'missed']);
  });

  it('move a lead to Missed when its follow-up passes, and back when it is rescheduled', async () => {
    const l = await lead(t.lc2!, { followUp: { dueAt: inAnHour() } });
    const queueOf = async () => (await api.call('GET', `/leads/${l.id}`, t.lc2!)).json().queue;
    expect(await queueOf()).toBe('fresh');

    await owner.query(`UPDATE leads SET next_followup_at = now() - interval '5 minutes' WHERE id = $1`, [l.id]);
    expect(await queueOf()).toBe('missed');
    expect((await everything(t.lc2!, 'queue=missed')).map((x) => x.id)).toContain(l.id);
    expect((await everything(t.lc2!, 'queue=fresh')).map((x) => x.id)).not.toContain(l.id);

    await owner.query(`UPDATE leads SET next_followup_at = now() + interval '1 day' WHERE id = $1`, [l.id]);
    expect(await queueOf()).toBe('fresh');
  });

  it('are what each person is allowed to see', async () => {
    const mine = (await api.call('GET', '/leads/queues', t.lc1!)).json();
    const all = (await api.call('GET', '/leads/queues', t.sa!)).json();
    expect(mine.total).toBeLessThan(all.total);
    expect(mine.unassigned).toBe(0);
    expect(all.unassigned).toBeGreaterThan(0);
  });
});

// ===================================================================== update

describe('editing a lead', () => {
  it('records each change with the old and the new value, and nothing when nothing changed', async () => {
    const l = await lead(t.lc1!, { name: 'Edit Me', intent: 'cold' });
    const res = await api.call('PATCH', `/leads/${l.id}`, t.lc1!, { name: 'Edited Name', intent: 'hot', email: 'edit@me.test', expectedClosureOn: '2026-12-01' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Edited Name', intent: 'hot', email: 'edit@me.test', expectedClosureOn: '2026-12-01' });

    const changes = (await activities(t.lc1!, l.id)).filter((a) => a.type === 'field_change');
    expect(changes.map((c) => c.field).sort()).toEqual(['email', 'expected_closure_on', 'intent', 'name']);
    expect(changes.find((c) => c.field === 'intent')).toMatchObject({ oldValue: 'cold', newValue: 'hot', user: { name: 'lc1' } });

    const again = await api.call('PATCH', `/leads/${l.id}`, t.lc1!, { name: 'Edited Name', intent: 'hot' });
    expect(again.statusCode).toBe(200);
    expect((await activities(t.lc1!, l.id)).filter((a) => a.type === 'field_change')).toHaveLength(4);
  });

  it('can clear a field', async () => {
    const l = await lead(t.lc1!, { email: 'clear@me.test', intent: 'warm' });
    const res = await api.call('PATCH', `/leads/${l.id}`, t.lc1!, { email: null, intent: null });
    expect(res.json()).toMatchObject({ email: null, intent: null });
  });

  it('keeps one lead per phone number when the number is changed', async () => {
    const a = await lead(t.lc1!, { phone: '9876533333' });
    const b = await lead(t.lc1!);
    expect(errorCode(await api.call('PATCH', `/leads/${b.id}`, t.lc1!, { phone: '+91 98765 33333' }))).toBe('DUPLICATE_LEAD');
    const moved = await api.call('PATCH', `/leads/${a.id}`, t.lc1!, { phone: '9876544444' });
    expect(moved.json().phone).toBe('919876544444');
    // The old number is free again.
    expect((await create(t.lc1!, { phone: '9876533333' })).statusCode).toBe(201);
  });

  it('refuses an empty change and unknown references', async () => {
    const l = await lead(t.lc1!);
    expect(errorCode(await api.call('PATCH', `/leads/${l.id}`, t.lc1!, {}))).toBe('VALIDATION_FAILED');
    expect(errorCode(await api.call('PATCH', `/leads/${l.id}`, t.lc1!, { interestedLocationId: '00000000-0000-4000-8000-000000000000' }))).toBe('REFERENCE_INVALID');
  });

  it('adds notes to the history', async () => {
    const l = await lead(t.lc1!);
    expect((await api.call('POST', `/leads/${l.id}/notes`, t.lc1!, { remark: 'Wants a hostel' })).statusCode).toBe(201);
    expect(errorCode(await api.call('POST', `/leads/${l.id}/notes`, t.lc1!, { remark: '   ' }))).toBe('VALIDATION_FAILED');
    const note = (await activities(t.lc1!, l.id)).find((a) => a.type === 'note');
    expect(note).toMatchObject({ remark: 'Wants a hostel', user: { name: 'lc1' } });
  });
});

// ===================================================================== status

describe('changing the status', () => {
  it('moves the lead and writes the change to its history', async () => {
    const l = await lead(t.lc1!);
    const res = await api.call('POST', `/leads/${l.id}/status`, t.lc1!, { statusId: await statusId('Contacted'), remark: 'Spoke to the father' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: { name: 'Contacted', queue: 'followup' }, queue: 'followup' });
    const entry = (await activities(t.lc1!, l.id)).find((a) => a.type === 'status_change');
    expect(entry).toMatchObject({ field: 'status', oldValue: 'New', newValue: 'Contacted', remark: 'Spoke to the father' });
  });

  it('asks for the next follow-up when the status needs one', async () => {
    const l = await lead(t.lc1!);
    const needsDate = await api.call('POST', `/leads/${l.id}/status`, t.lc1!, { statusId: await statusId('Follow-up') });
    expect(needsDate.statusCode).toBe(400);
    expect(errorCode(needsDate)).toBe('FOLLOWUP_REQUIRED');
    expect((await row(l.id)).status_id).not.toBe(await statusId('Follow-up')); // nothing changed

    const ok = await api.call('POST', `/leads/${l.id}/status`, t.lc1!, { statusId: await statusId('Follow-up'), followUp: { dueAt: inAnHour(), note: 'Ask about fees' } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ status: { name: 'Follow-up' }, openFollowUps: 1 });
    expect(ok.json().nextFollowupAt).not.toBeNull();
  });

  it('accepts a status that needs a follow-up when one is already coming up', async () => {
    const l = await lead(t.lc1!, { followUp: { dueAt: inAnHour() } });
    const res = await api.call('POST', `/leads/${l.id}/status`, t.lc1!, { statusId: await statusId('Counselled') });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('closes the lead\'s open follow-ups when it is moved to a closed status', async () => {
    const l = await lead(t.lc1!, { followUp: { dueAt: inAnHour() } });
    const res = await api.call('POST', `/leads/${l.id}/status`, t.lc1!, { statusId: await statusId('Not Interested'), remark: 'Joined elsewhere' });
    expect(res.json()).toMatchObject({ status: { name: 'Not Interested', isOpen: false }, queue: 'closed', nextFollowupAt: null, openFollowUps: 0 });
  });

  it('works with sub-statuses and refuses one that belongs elsewhere', async () => {
    const contacted = await statusId('Contacted');
    const sub = (await api.call('POST', `/lead-statuses/${contacted}/substatuses`, t.sa!, { name: 'Not reachable' })).json();
    const subId = sub.substatuses.find((s: { name: string }) => s.name === 'Not reachable').id;
    const l = await lead(t.lc1!);

    const ok = await api.call('POST', `/leads/${l.id}/status`, t.lc1!, { statusId: contacted, substatusId: subId });
    expect(ok.json().substatus).toMatchObject({ name: 'Not reachable' });
    expect((await activities(t.lc1!, l.id)).find((a) => a.type === 'status_change')?.newValue).toBe('Contacted / Not reachable');

    const wrong = await api.call('POST', `/leads/${l.id}/status`, t.lc1!, { statusId: await statusId('Follow-up'), substatusId: subId, followUp: { dueAt: inAnHour() } });
    expect(errorCode(wrong)).toBe('STATUS_INVALID');
    expect(errorCode(await api.call('POST', `/leads/${l.id}/status`, t.lc1!, { statusId: '00000000-0000-4000-8000-000000000000' }))).toBe('STATUS_INVALID');
  });

  it('records a remark as a note when the status stays the same', async () => {
    const l = await lead(t.lc1!);
    await api.call('POST', `/leads/${l.id}/status`, t.lc1!, { statusId: await statusId('New'), remark: 'Still thinking' });
    const types = (await activities(t.lc1!, l.id)).map((a) => a.type);
    expect(types).toContain('note');
    expect(types).not.toContain('status_change');
  });
});

// ===================================================================== assign

describe('handing out leads', () => {
  it('lets an Admin give a lead to someone on their team: history, follow-ups and a notification follow', async () => {
    const l = await lead(t.lc1!, { followUp: { dueAt: inAnHour() } });
    const res = await api.call('POST', `/leads/${l.id}/assign`, t.admin!, { userId: idOf('lc2') });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().assignedTo).toMatchObject({ name: 'lc2' });

    const entry = (await activities(t.admin!, l.id)).find((a) => a.type === 'assignment' && a.oldValue === 'lc1');
    expect(entry).toMatchObject({ field: 'assigned_to', newValue: 'lc2', remark: 'By admin' });
    expect((await owner.query(`SELECT user_id FROM followups WHERE lead_id = $1 AND done_at IS NULL`, [l.id])).rows[0].user_id).toBe(idOf('lc2'));
    const told = await owner.query(`SELECT 1 FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND payload->>'leadId' = $3 AND payload->>'event' = 'lead_assigned'`, [fx.tenantId, idOf('lc2'), l.id]);
    expect(told.rowCount).toBe(1);

    // It is now lc2's, no longer lc1's.
    expect((await api.call('GET', `/leads/${l.id}`, t.lc2!)).statusCode).toBe(200);
    expect((await api.call('GET', `/leads/${l.id}`, t.lc1!)).statusCode).toBe(404);
  });

  it('can take a lead back to the pool, and pick one up from it', async () => {
    const l = await lead(t.lc1!);
    const pooled = await api.call('POST', `/leads/${l.id}/assign`, t.admin!, { userId: null });
    expect(pooled.json().assignedTo).toBeNull();
    expect((await row(l.id)).assigned_at).toBeNull();
    const picked = await api.call('POST', `/leads/${l.id}/assign`, t.admin!, { userId: idOf('lc3') });
    expect(picked.json().assignedTo).toMatchObject({ name: 'lc3' });
    expect((await row(l.id)).assigned_at).not.toBeNull();
  });

  describe('to someone who is not working right now', () => {
    const attendanceOf = async (name: string) =>
      (await owner.query(`SELECT id FROM attendance_records WHERE tenant_id = $1 AND user_id = $2 ORDER BY work_date DESC LIMIT 1`, [fx.tenantId, idOf(name)])).rows[0].id as string;

    it('refuses a counsellor who is on a break, unless the Admin confirms', async () => {
      const attendanceId = await attendanceOf('lc3');
      const type = (await owner.query(`INSERT INTO break_types (tenant_id, name, allowed_minutes) VALUES ($1, 'Assign test', 30) RETURNING id`, [fx.tenantId])).rows[0].id as string;
      await owner.query(`INSERT INTO break_logs (tenant_id, attendance_id, break_type_id) VALUES ($1, $2, $3)`, [fx.tenantId, attendanceId, type]);
      try {
        const l = await lead(t.lc1!);
        const refused = await api.call('POST', `/leads/${l.id}/assign`, t.admin!, { userId: idOf('lc3') });
        expect(refused.statusCode).toBe(409);
        expect(errorCode(refused)).toBe('ASSIGNEE_UNAVAILABLE');
        expect(refused.json().error.details).toMatchObject({ reason: 'on_break' });
        expect((await row(l.id)).assigned_to).toBe(idOf('lc1'));

        const bulk = await api.call('POST', '/leads/bulk/assign', t.admin!, { leadIds: [l.id], userId: idOf('lc3') });
        expect(errorCode(bulk)).toBe('ASSIGNEE_UNAVAILABLE');

        const confirmed = await api.call('POST', `/leads/${l.id}/assign`, t.admin!, { userId: idOf('lc3'), allowUnavailable: true });
        expect(confirmed.statusCode, confirmed.body).toBe(200);
        expect(confirmed.json().assignedTo).toMatchObject({ name: 'lc3' });
      } finally {
        await owner.query(`DELETE FROM break_logs WHERE attendance_id = $1`, [attendanceId]);
        await owner.query(`DELETE FROM break_types WHERE id = $1`, [type]);
      }
    });

    it('refuses a counsellor who has already checked out', async () => {
      const attendanceId = await attendanceOf('lc3');
      await owner.query(`UPDATE attendance_records SET check_out_at = now(), check_out_reason = 'manual' WHERE id = $1`, [attendanceId]);
      try {
        const l = await lead(t.lc1!);
        const refused = await api.call('POST', `/leads/${l.id}/assign`, t.admin!, { userId: idOf('lc3') });
        expect(errorCode(refused)).toBe('ASSIGNEE_UNAVAILABLE');
        expect(refused.json().error.details).toMatchObject({ reason: 'checked_out' });
        // Someone who is not tracked by attendance is never refused.
        expect((await api.call('POST', `/leads/${l.id}/assign`, t.sa!, { userId: idOf('admin') })).statusCode).toBe(200);
      } finally {
        await owner.query(`UPDATE attendance_records SET check_out_at = NULL, check_out_reason = NULL WHERE id = $1`, [attendanceId]);
      }
    });
  });

  it('changes nothing when the lead already belongs to that person', async () => {
    const l = await lead(t.lc1!);
    const before = (await activities(t.admin!, l.id)).length;
    await api.call('POST', `/leads/${l.id}/assign`, t.admin!, { userId: idOf('lc1') });
    expect((await activities(t.admin!, l.id)).length).toBe(before);
  });

  it('is for those with the permission, and only inside their team', async () => {
    const l = await lead(t.lc1!);
    expect((await api.call('POST', `/leads/${l.id}/assign`, t.lc1!, { userId: idOf('lc2') })).statusCode).toBe(403);
    expect(errorCode(await api.call('POST', `/leads/${l.id}/assign`, t.admin!, { userId: idOf('counsellor2') }))).toBe('ASSIGNEE_INVALID');
    expect((await api.call('POST', `/leads/${l.id}/assign`, t.admin2!, { userId: idOf('counsellor2') })).statusCode).toBe(404); // not their lead
  });

  describe('in bulk', () => {
    it('moves many leads at once', async () => {
      const made = await Promise.all([lead(t.lc1!), lead(t.lc1!), lead(t.lc1!)]);
      const res = await api.call('POST', '/leads/bulk/assign', t.admin!, { leadIds: made.map((m) => m.id), userId: idOf('lc3') });
      expect(res.json()).toEqual({ requested: 3, changed: 3 });
      for (const m of made) expect((await row(m.id)).assigned_to).toBe(idOf('lc3'));
      const told = await owner.query(`SELECT payload FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND payload->>'event' = 'leads_assigned'`, [fx.tenantId, idOf('lc3')]);
      expect(told.rows[0].payload).toMatchObject({ count: 3, by: 'admin' });
    });

    it('is all or nothing: one lead that cannot be seen stops the whole request', async () => {
      const mine = await lead(t.lc1!);
      const foreign = await lead(t.counsellor2!);
      const res = await api.call('POST', '/leads/bulk/assign', t.admin!, { leadIds: [mine.id, foreign.id], userId: idOf('lc2') });
      expect(res.statusCode).toBe(404);
      expect(errorCode(res)).toBe('LEADS_NOT_FOUND');
      expect(res.json().error.details.missing).toEqual([foreign.id]);
      expect((await row(mine.id)).assigned_to).toBe(idOf('lc1'));
    });

    it('changes the status of many leads, but not to one that needs a follow-up date each', async () => {
      const made = await Promise.all([lead(t.lc1!), lead(t.lc2!)]);
      const ids = made.map((m) => m.id);
      expect(errorCode(await api.call('POST', '/leads/bulk/status', t.admin!, { leadIds: ids, statusId: await statusId('Follow-up') }))).toBe('BULK_FOLLOWUP_STATUS');

      const res = await api.call('POST', '/leads/bulk/status', t.admin!, { leadIds: ids, statusId: await statusId('Contacted'), remark: 'Bulk update' });
      expect(res.json()).toEqual({ requested: 2, changed: 2 });
      expect((await row(ids[0]!)).status_id).toBe(await statusId('Contacted'));
      expect((await activities(t.admin!, ids[1]!)).find((a) => a.type === 'status_change')).toMatchObject({ newValue: 'Contacted', remark: 'Bulk update' });
      expect((await api.call('POST', '/leads/bulk/status', t.admin!, { leadIds: ids, statusId: await statusId('Contacted') })).json()).toMatchObject({ changed: 0 });
    });

    it('is for those who hand out leads, and limits its size', async () => {
      const l = await lead(t.lc1!);
      expect((await api.call('POST', '/leads/bulk/assign', t.lc1!, { leadIds: [l.id], userId: idOf('lc2') })).statusCode).toBe(403);
      expect(errorCode(await api.call('POST', '/leads/bulk/assign', t.admin!, { leadIds: [], userId: idOf('lc2') }))).toBe('VALIDATION_FAILED');
    });
  });
});

// ===================================================================== delete

describe('deleting a lead', () => {
  it('hides it everywhere, frees its phone number and keeps the history', async () => {
    const number = phone();
    const l = await lead(t.lc1!, { phone: number, followUp: { dueAt: inAnHour() } });
    expect((await api.call('DELETE', `/leads/${l.id}`, t.admin!)).statusCode).toBe(403); // only those with the permission
    expect((await api.call('DELETE', `/leads/${l.id}`, t.sa!)).statusCode).toBe(204);

    expect((await api.call('GET', `/leads/${l.id}`, t.sa!)).statusCode).toBe(404);
    expect((await everything(t.sa!)).map((x) => x.id)).not.toContain(l.id);
    expect((await api.call('DELETE', `/leads/${l.id}`, t.sa!)).statusCode).toBe(404);
    expect((await row(l.id)).deleted_at).not.toBeNull();
    expect((await owner.query(`SELECT count(*)::int AS n FROM lead_activities WHERE lead_id = $1`, [l.id])).rows[0].n).toBeGreaterThan(1);

    expect((await create(t.lc1!, { phone: number })).statusCode).toBe(201);
  });
});

// ================================================================== settings

describe('statuses and sub-statuses', () => {
  it('are listed for anyone who works with leads; switched-off ones only for those who manage them', async () => {
    const list = await api.call('GET', '/lead-statuses', t.lc1!);
    expect(list.json().map((s: { name: string }) => s.name)).toEqual(['New', 'Contacted', 'Follow-up', 'Counselled', 'Fee Paid', 'Not Interested']);
    expect(list.json()[2]).toMatchObject({ requiresFollowup: true, isOpen: true, queue: 'followup' });
  });

  it('can be added, changed and switched off by those who manage settings', async () => {
    expect((await api.call('POST', '/lead-statuses', t.lc1!, { name: 'Custom', queue: 'followup', isOpen: true, requiresFollowup: false })).statusCode).toBe(403);
    const created = await api.call('POST', '/lead-statuses', t.sa!, { name: 'Application Sent', queue: 'counselled', isOpen: true, requiresFollowup: true });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ name: 'Application Sent', sortOrder: 6, isActive: true, substatuses: [] });
    expect(errorCode(await api.call('POST', '/lead-statuses', t.sa!, { name: 'application sent', queue: 'closed', isOpen: false, requiresFollowup: false }))).toBe('STATUS_EXISTS');

    const edited = await api.call('PATCH', `/lead-statuses/${created.json().id}`, t.sa!, { requiresFollowup: false, isActive: false });
    expect(edited.json()).toMatchObject({ requiresFollowup: false, isActive: false });
    expect((await api.call('GET', '/lead-statuses', t.lc1!)).json().map((s: { name: string }) => s.name)).not.toContain('Application Sent');
    expect((await api.call('GET', '/lead-statuses', t.sa!)).json().map((s: { name: string }) => s.name)).toContain('Application Sent');
    const l = await lead(t.lc1!);
    expect(errorCode(await api.call('POST', `/leads/${l.id}/status`, t.lc1!, { statusId: created.json().id }))).toBe('STATUS_INVALID');
  });

  it('always leave at least one "fresh" status for new leads to start in', async () => {
    const fresh = await statusId('New');
    expect(errorCode(await api.call('PATCH', `/lead-statuses/${fresh}`, t.sa!, { isActive: false }))).toBe('LAST_FRESH_STATUS');
    expect(errorCode(await api.call('PATCH', `/lead-statuses/${fresh}`, t.sa!, { queue: 'followup' }))).toBe('LAST_FRESH_STATUS');

    const second = await api.call('POST', '/lead-statuses', t.sa!, { name: 'Enquiry', queue: 'fresh', isOpen: true, requiresFollowup: false });
    expect((await api.call('PATCH', `/lead-statuses/${fresh}`, t.sa!, { isActive: false })).statusCode).toBe(200);
    // New leads now start in the other fresh status.
    expect((await lead(t.lc1!)).status.name).toBe('Enquiry');
    await api.call('PATCH', `/lead-statuses/${fresh}`, t.sa!, { isActive: true });
    await api.call('PATCH', `/lead-statuses/${second.json().id}`, t.sa!, { isActive: false });
  });

  it('manage sub-statuses, and keep those in use', async () => {
    const status = await statusId('Counselled');
    const added = await api.call('POST', `/lead-statuses/${status}/substatuses`, t.sa!, { name: 'Documents pending' });
    const sub = added.json().substatuses[0];
    expect(errorCode(await api.call('POST', `/lead-statuses/${status}/substatuses`, t.sa!, { name: 'documents PENDING' }))).toBe('SUBSTATUS_EXISTS');

    const renamed = await api.call('PATCH', `/lead-substatuses/${sub.id}`, t.sa!, { name: 'Docs pending' });
    expect(renamed.json().substatuses[0].name).toBe('Docs pending');

    const l = await lead(t.lc1!, { followUp: { dueAt: inAnHour() } });
    await api.call('POST', `/leads/${l.id}/status`, t.lc1!, { statusId: status, substatusId: sub.id });
    expect(errorCode(await api.call('DELETE', `/lead-substatuses/${sub.id}`, t.sa!))).toBe('SUBSTATUS_IN_USE');
    await api.call('POST', `/leads/${l.id}/status`, t.lc1!, { statusId: await statusId('Contacted') });
    expect((await api.call('DELETE', `/lead-substatuses/${sub.id}`, t.sa!)).statusCode).toBe(204);
  });
});

// ===================================================================== history

describe('the history of a lead', () => {
  it('lists the newest first with who did what, and pages', async () => {
    const l = await lead(t.lc1!);
    for (let i = 1; i <= 5; i++) await api.call('POST', `/leads/${l.id}/notes`, t.lc1!, { remark: `Note ${i}` });

    const first = await api.call('GET', `/leads/${l.id}/activities?limit=3`, t.lc1!);
    expect(first.json().items.map((a: { remark: string }) => a.remark)).toEqual(['Note 5', 'Note 4', 'Note 3']);
    expect(first.json().items[0].user).toMatchObject({ name: 'lc1' });
    const second = await api.call('GET', `/leads/${l.id}/activities?limit=3&cursor=${first.json().nextCursor}`, t.lc1!);
    expect(second.json().items[0].remark).toBe('Note 2');
    const seen = [...first.json().items, ...second.json().items].map((a: { id: string }) => a.id);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
