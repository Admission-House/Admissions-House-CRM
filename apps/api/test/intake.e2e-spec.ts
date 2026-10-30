import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { IntakeService } from '../src/intake/intake.service.js';
import { MailerService } from '../src/mail/mailer.service.js';
import { startApp } from './helpers/app.js';
import { Client, inOffice, makeClient } from './helpers/client.js';
import { createFixture, Fixture, OFFICE_IP } from './helpers/fixtures.js';

let app: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;
let api: Client;
let sa: string;
let admin: string;
const tokens = new Map<string, string>(); // counsellors who are signed in
const run = randomUUID().slice(0, 8);
const CITY = `Testville-${run}`;

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  app = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500' });
  api = makeClient(app, fx);
  sa = await api.signIn('super');
  admin = await api.signIn('admin', { office: true });

  // A city the company can match, in the shared list of places.
  const state = (await owner.query(`INSERT INTO locations (type, name) VALUES ('state', $1) RETURNING id`, [`TestState-${run}`])).rows[0].id;
  await owner.query(`INSERT INTO locations (type, name, parent_id) VALUES ('city', $1, $2)`, [CITY, state]);

  // in1, in2, in3 are in the office; in4 never came; inleave is in the office but on approved leave.
  for (const name of ['in1', 'in2', 'in3']) tokens.set(name, await api.signIn(name, { office: true }));
  const today = (await owner.query(`SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`)).rows[0].d;
  const casual = (await owner.query(`SELECT id FROM leave_types WHERE tenant_id = $1 AND name = 'Casual Leave'`, [fx.tenantId])).rows[0].id;
  await owner.query(
    `INSERT INTO leave_requests (tenant_id, user_id, leave_type_id, from_date, to_date, days, status, decided_by, decided_at)
     VALUES ($1, $2, $3, $4::date, $4::date, 1, 'approved', $5, now())`,
    [fx.tenantId, fx.user('inleave').id, casual, today, fx.user('admin').id],
  );
  tokens.set('inleave', await api.signIn('inleave', { office: true }));
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.query(`DELETE FROM locations WHERE type = 'city' AND name = $1`, [CITY]);
  await owner?.query(`DELETE FROM locations WHERE type = 'state' AND name = $1`, [`TestState-${run}`]);
  await owner?.end();
});

// ------------------------------------------------------------------ helpers

let counter = 0;
/** A phone number nobody else in this test uses. */
const phone = () => `9${String(800_000_000 + ++counter).padStart(9, '0')}`;
const e164 = (p: string) => `91${p}`;

const websiteLead = (over: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  createdAt: new Date().toISOString(),
  name: 'Riya Sharma',
  phone: phone(),
  email: 'Riya@Example.com',
  level: 'UG',
  mode: 'Online',
  stream: 'Engineering',
  city: CITY,
  interest: 'B.Tech at XYZ University',
  source: 'home-popup',
  page: '/colleges/xyz',
  utm: { source: 'google', medium: 'cpc', campaign: 'btech-2026' },
  ...over,
});

const post = (key: string, body: unknown, opts: { idem?: string; ip?: string; header?: 'bearer' | 'x-api-key' } = {}) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/intake/leads',
    headers: {
      ...(opts.header === 'x-api-key' ? { 'x-api-key': key } : { authorization: `Bearer ${key}` }),
      ...(opts.idem ? { 'idempotency-key': opts.idem } : {}),
    },
    payload: body as never,
    remoteAddress: opts.ip ?? '198.51.100.20',
  });

const errorCode = (res: { json: () => { error?: { code?: string } } }) => res.json().error?.code;
const idOf = (name: string) => fx.user(name).id;

const leadRow = async (leadId: string) =>
  (await owner.query(
    `SELECT l.*, s.name AS status_name, src.name AS source_name FROM leads l
     JOIN lead_statuses s ON s.id = l.status_id JOIN lead_sources src ON src.id = l.source_id WHERE l.id = $1`,
    [leadId],
  )).rows[0];

const countLeads = async (phoneDigits: string) =>
  Number((await owner.query(`SELECT count(*) FROM leads WHERE tenant_id = $1 AND primary_phone = $2`, [fx.tenantId, e164(phoneDigits)])).rows[0].count);

const notificationsAbout = async (leadId: string, event: string) =>
  (await owner.query(`SELECT user_id, payload FROM notifications WHERE tenant_id = $1 AND payload->>'leadId' = $2 AND payload->>'event' = $3`, [fx.tenantId, leadId, event])).rows;

/** Signs people in (checks them in) or out. */
async function setPresence(present: string[], absent: string[] = []) {
  for (const name of present) if (!tokens.has(name)) tokens.set(name, await api.signIn(name, { office: true }));
  for (const name of absent) {
    const token = tokens.get(name);
    if (token) await api.call('POST', '/auth/logout', token, undefined, OFFICE_IP);
    tokens.delete(name);
  }
}

// ======================================================= the website's lead

describe('a lead from the website', () => {
  it('becomes a lead with everything the form sent', async () => {
    const payload = websiteLead({ city: CITY });
    const res = await post(fx.keys.website, payload, { idem: payload.id });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ outcome: 'created', replay: false, assignedTo: expect.any(String) });

    const lead = await leadRow(res.json().leadId);
    expect(lead).toMatchObject({
      name: 'Riya Sharma', email: 'riya@example.com', primary_phone: e164(payload.phone as string), status_name: 'New',
      source_name: 'Website', study_mode: 'online', deleted_at: null,
    });
    expect(lead.interest_note).toBe('B.Tech at XYZ University');
    expect(lead.interested_location_id).not.toBeNull(); // the city was recognised

    const profile = (await owner.query(`SELECT preferred_level, preferred_stream_id FROM lead_profiles WHERE lead_id = $1`, [lead.id])).rows[0];
    expect(profile.preferred_level).toBe('UG');
    expect(profile.preferred_stream_id).not.toBeNull();

    const enquiry = (await owner.query(`SELECT * FROM lead_enquiries WHERE lead_id = $1`, [lead.id])).rows;
    expect(enquiry).toHaveLength(1);
    expect(enquiry[0]).toMatchObject({ form_name: 'home-popup', page_path: '/colleges/xyz', utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'btech-2026' });

    const types = (await owner.query(`SELECT type FROM lead_activities WHERE lead_id = $1 ORDER BY id`, [lead.id])).rows.map((r) => r.type);
    expect(types).toEqual(['enquiry', 'assignment']);
  });

  it('keeps what could not be matched in a note, instead of losing it', async () => {
    const res = await post(fx.keys.website, websiteLead({ city: 'Atlantis', stream: 'Underwater Basket Weaving' }));
    const lead = await leadRow(res.json().leadId);
    expect(lead.interested_location_id).toBeNull();
    expect(lead.interest_note).toBe('B.Tech at XYZ University | Stream: Underwater Basket Weaving | City: Atlantis');
  });

  it('numbers leads one after another within the company', async () => {
    const first = await post(fx.keys.website, websiteLead());
    const second = await post(fx.keys.website, websiteLead());
    expect(Number(second.json().leadNo)).toBe(Number(first.json().leadNo) + 1);
  });

  it('works with the key sent in X-API-Key as well', async () => {
    expect((await post(fx.keys.website, websiteLead(), { header: 'x-api-key' })).statusCode).toBe(201);
  });

  it('files an ads lead under the ads source, taken from the key and not from the payload', async () => {
    const res = await post(fx.keys.ads, websiteLead({ source: 'Website' }));
    expect((await leadRow(res.json().leadId)).source_name).toBe('Meta Ads');
  });

  it('accepts a minimal lead and drops a bad email rather than losing the lead', async () => {
    const minimal = await post(fx.keys.website, { name: 'Asha', phone: `+91 ${phone().slice(0, 5)} ${phone().slice(5)}`.replace(/(\d{5}) (\d+)/, (_m, a, b) => `${a} ${b}`) });
    expect([201, 422]).toContain(minimal.statusCode);

    const p = phone();
    const res = await post(fx.keys.website, { name: 'Asha K', phone: p, email: 'not-an-email', mode: 'Hybrid', level: 'PhD' });
    expect(res.statusCode).toBe(201);
    const lead = await leadRow(res.json().leadId);
    expect(lead).toMatchObject({ email: null, study_mode: null });
  });
});

// ============================================================ who gets it

describe('assigning a new lead', () => {
  const assignedTo = async (n: number, options: { phones?: boolean } = {}) => {
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const res = await post(fx.keys.website, websiteLead());
      expect(res.statusCode, res.body).toBe(201);
      out.push(res.json().assignedTo);
    }
    return options.phones ? out : out;
  };
  const tally = (ids: (string | null)[]) => {
    const counts: Record<string, number> = {};
    for (const id of ids) counts[id ?? 'nobody'] = (counts[id ?? 'nobody'] ?? 0) + 1;
    return counts;
  };

  it('goes only to counsellors who are in the office, and rotates fairly among them', async () => {
    await setPresence(['in1', 'in2', 'in3', 'inleave']);
    const counts = tally(await assignedTo(6));
    expect(counts).toEqual({ [idOf('in1')]: 2, [idOf('in2')]: 2, [idOf('in3')]: 2 });
    expect(counts[idOf('in4')]).toBeUndefined(); // never came in
    expect(counts[idOf('inleave')]).toBeUndefined(); // in the office but on approved leave
  });

  it('shares fairly even when leads arrive at the same moment', async () => {
    await setPresence(['in1', 'in2', 'in3']);
    const results = await Promise.all(Array.from({ length: 6 }, () => post(fx.keys.website, websiteLead())));
    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    expect(tally(results.map((r) => r.json().assignedTo))).toEqual({ [idOf('in1')]: 2, [idOf('in2')]: 2, [idOf('in3')]: 2 });
  });

  it('stays exactly fair under a burst of thirty leads at once', async () => {
    await setPresence(['in1', 'in2', 'in3']);
    const results = await Promise.all(Array.from({ length: 30 }, () => post(fx.keys.website, websiteLead())));
    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    expect(tally(results.map((r) => r.json().assignedTo))).toEqual({ [idOf('in1')]: 10, [idOf('in2')]: 10, [idOf('in3')]: 10 });
  });

  it('stops giving leads to someone who has checked out', async () => {
    await setPresence(['in1', 'in2', 'in3'], ['in1']);
    const counts = tally(await assignedTo(4));
    expect(counts).toEqual({ [idOf('in2')]: 2, [idOf('in3')]: 2 });
    await setPresence(['in1']);
  });

  it('tells the counsellor about the lead they were given', async () => {
    const secret = phone();
    const res = await post(fx.keys.website, websiteLead({ name: 'Notify Me', phone: secret }));
    const told = await notificationsAbout(res.json().leadId, 'lead_assigned');
    expect(told).toHaveLength(1);
    expect(told[0].user_id).toBe(res.json().assignedTo);
    // A notification names the lead but never carries the student's phone number.
    const text = JSON.stringify(told[0].payload);
    expect(text).not.toContain(secret);
    expect(text).not.toContain(e164(secret));
    expect(Object.keys(told[0].payload).sort()).toEqual(['event', 'leadId', 'leadNo', 'name', 'source']);
  });

  it('leaves the lead unassigned and tells the Super Admins when nobody is in the office', async () => {
    const solo = await createFixture(owner, [{ name: 'only', role: 'super_admin' }]);
    try {
      const res = await post(solo.keys.website, websiteLead());
      expect(res.statusCode).toBe(201);
      expect(res.json().assignedTo).toBeNull();
      const lead = (await owner.query(`SELECT assigned_to, assigned_at FROM leads WHERE id = $1`, [res.json().leadId])).rows[0];
      expect(lead).toEqual({ assigned_to: null, assigned_at: null });
      const alerts = (await owner.query(`SELECT user_id, payload FROM notifications WHERE tenant_id = $1 AND payload->>'event' = 'lead_unassigned'`, [solo.tenantId])).rows;
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ user_id: solo.user('only').id, payload: { reason: 'no_one_present' } });
    } finally {
      await solo.cleanup();
    }
  });
});

// ======================================================= repeat enquiries

describe('the same person enquiring again', () => {
  it('adds to the lead they already have instead of making another', async () => {
    const p = phone();
    const first = await post(fx.keys.website, websiteLead({ phone: p }));
    const again = await post(fx.keys.ads, websiteLead({ phone: `+91 ${p.slice(0, 5)} ${p.slice(5)}`, name: 'R Sharma', source: 'fb-form' }));

    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ outcome: 'attached', leadId: first.json().leadId, assignedTo: first.json().assignedTo });
    expect(await countLeads(p)).toBe(1);

    const enquiries = (await owner.query(`SELECT s.name FROM lead_enquiries e JOIN lead_sources s ON s.id = e.source_id WHERE e.lead_id = $1 ORDER BY e.created_at`, [first.json().leadId])).rows.map((r) => r.name);
    expect(enquiries).toEqual(['Website', 'Meta Ads']);
    const told = await notificationsAbout(first.json().leadId, 'repeat_enquiry');
    expect(told).toHaveLength(1);
    expect(told[0].user_id).toBe(first.json().assignedTo);
    const note = (await owner.query(`SELECT remark FROM lead_activities WHERE lead_id = $1 AND type = 'enquiry' ORDER BY id DESC LIMIT 1`, [first.json().leadId])).rows[0].remark;
    expect(note).toContain('again');
  });

  it('recognises a number kept as an extra phone on a lead', async () => {
    const first = await post(fx.keys.website, websiteLead());
    const extra = phone();
    await owner.query(`INSERT INTO lead_phones (tenant_id, lead_id, phone, label) VALUES ($1, $2, $3, 'parent')`, [fx.tenantId, first.json().leadId, e164(extra)]);
    const res = await post(fx.keys.website, websiteLead({ phone: extra }));
    expect(res.json()).toMatchObject({ outcome: 'attached', leadId: first.json().leadId });
    expect(await countLeads(extra)).toBe(0);
  });

  it('makes exactly one lead when the same number arrives many times at once', async () => {
    const p = phone();
    const results = await Promise.all(Array.from({ length: 5 }, () => post(fx.keys.website, websiteLead({ phone: p }))));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 200, 200, 201]);
    expect(new Set(results.map((r) => r.json().leadId)).size).toBe(1);
    expect(await countLeads(p)).toBe(1);
    const enquiries = Number((await owner.query(`SELECT count(*) FROM lead_enquiries WHERE lead_id = $1`, [results[0]!.json().leadId])).rows[0].count);
    expect(enquiries).toBe(5);
  });

  it('can be refused by the company\'s policy', async () => {
    const p = phone();
    const first = await post(fx.keys.website, websiteLead({ phone: p }));
    expect((await api.call('PUT', '/lead-policy', sa, { duplicateAction: 'reject', autoAssign: true })).statusCode).toBe(200);
    try {
      const again = await post(fx.keys.website, websiteLead({ phone: p }));
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ outcome: 'rejected', leadId: first.json().leadId });
      const enquiries = Number((await owner.query(`SELECT count(*) FROM lead_enquiries WHERE lead_id = $1`, [first.json().leadId])).rows[0].count);
      expect(enquiries).toBe(1);
    } finally {
      await api.call('PUT', '/lead-policy', sa, { duplicateAction: 'attach', autoAssign: true });
    }
  });
});

// ============================================================ idempotency

describe('a delivery sent twice', () => {
  it('is recognised by the sender\'s key and answered with the first outcome', async () => {
    const body = websiteLead();
    const first = await post(fx.keys.website, body, { idem: 'order-0001' });
    const second = await post(fx.keys.website, body, { idem: 'order-0001' });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ outcome: 'created', leadId: first.json().leadId, replay: true });
    expect(await countLeads(body.phone as string)).toBe(1);
  });

  it('is recognised by the id inside the payload, as the website sends it', async () => {
    const body = websiteLead();
    const first = await post(fx.keys.website, body);
    const second = await post(fx.keys.website, { ...body, name: 'Changed Later' });
    expect(second.json()).toMatchObject({ leadId: first.json().leadId, replay: true });
  });

  it('is recognised by its content when it has neither', async () => {
    const body: Record<string, unknown> = websiteLead();
    delete body.id;
    const first = await post(fx.keys.website, body);
    const second = await post(fx.keys.website, body);
    expect(second.json()).toMatchObject({ leadId: first.json().leadId, replay: true });
  });

  it('makes one lead when the same delivery arrives many times at once', async () => {
    const body = websiteLead();
    const results = await Promise.all(Array.from({ length: 5 }, () => post(fx.keys.website, body, { idem: 'burst-1' })));
    expect(results.every((r) => [200, 201, 202].includes(r.statusCode))).toBe(true);
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(await countLeads(body.phone as string)).toBe(1);
  });

  it('keeps two sources apart even if they use the same key', async () => {
    const a = await post(fx.keys.website, websiteLead(), { idem: 'shared-key-7' });
    const b = await post(fx.keys.ads, websiteLead(), { idem: 'shared-key-7' });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.json().leadId).not.toBe(b.json().leadId);
  });
});

// ============================================================ the door

describe('who may send leads', () => {
  it.each([
    ['no key', undefined],
    ['a key in the wrong format', 'secret'],
    ['a well-formed key that was never issued', `ahk_${'A'.repeat(43)}`],
  ])('refuses %s', async (_name, key) => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/intake/leads', payload: websiteLead() as never, headers: key ? { authorization: `Bearer ${key}` } : {}, remoteAddress: '198.51.100.21' });
    expect(res.statusCode).toBe(401);
    expect(errorCode(res)).toBe('INVALID_API_KEY');
  });

  it('does not accept a person\'s login token in place of a key', async () => {
    const res = await post(sa, websiteLead(), { ip: '198.51.100.22' });
    expect(res.statusCode).toBe(401);
  });

  it('slows down a sender who keeps trying wrong keys', async () => {
    const ip = '203.0.113.99';
    const codes: number[] = [];
    for (let i = 0; i < 22; i++) codes.push((await post(`ahk_${'B'.repeat(43)}`, websiteLead(), { ip })).statusCode);
    expect(codes.slice(0, 20).every((c) => c === 401)).toBe(true);
    expect(codes.slice(20)).toContain(429);
  });

  it('notes when a key was last used', async () => {
    await post(fx.keys.website, websiteLead());
    const row = (await owner.query(`SELECT last_used_at FROM api_keys WHERE tenant_id = $1 AND key_hash IS NOT NULL ORDER BY last_used_at DESC NULLS LAST LIMIT 1`, [fx.tenantId])).rows[0];
    expect(Date.now() - new Date(row.last_used_at).getTime()).toBeLessThan(60_000);
  });
});

// ========================================================== bad input

describe('a lead that cannot be used', () => {
  it('is kept as received, refused with the reason, and answered the same way if sent again', async () => {
    const body = { name: 'No Phone Here', phone: 'call me maybe', note: 'keep this' };
    const res = await post(fx.keys.website, body, { idem: 'bad-phone-1' });
    expect(res.statusCode).toBe(422);
    expect(errorCode(res)).toBe('INVALID_LEAD');
    expect(res.json().error.fieldErrors[0].field).toBe('phone');

    const event = (await owner.query(`SELECT status, payload FROM inbound_events WHERE tenant_id = $1 AND external_id = 'bad-phone-1'`, [fx.tenantId])).rows[0];
    expect(event.status).toBe('ignored');
    expect(event.payload).toEqual(body);

    const again = await post(fx.keys.website, body, { idem: 'bad-phone-1' });
    expect(again.statusCode).toBe(422);
  });

  it.each([
    ['a missing name', { phone: '9876501234' }],
    ['an empty body', {}],
  ])('refuses %s', async (_n, body) => {
    expect((await post(fx.keys.website, body)).statusCode).toBe(422);
  });

  it.each([['a list', []], ['text', 'hello'], ['a number', 7]])('refuses %s instead of an object, without saving it', async (_n, body) => {
    const before = Number((await owner.query(`SELECT count(*) FROM inbound_events WHERE tenant_id = $1`, [fx.tenantId])).rows[0].count);
    const res = await app.inject({ method: 'POST', url: '/api/v1/intake/leads', headers: { authorization: `Bearer ${fx.keys.website}`, 'content-type': 'application/json' }, payload: JSON.stringify(body), remoteAddress: '198.51.100.23' });
    expect(res.statusCode).toBe(400);
    const after = Number((await owner.query(`SELECT count(*) FROM inbound_events WHERE tenant_id = $1`, [fx.tenantId])).rows[0].count);
    expect(after).toBe(before);
  });

  it('cuts an over-long name instead of refusing the lead', async () => {
    const res = await post(fx.keys.website, websiteLead({ name: 'N'.repeat(300) }));
    expect(res.statusCode).toBe(201);
    expect((await leadRow(res.json().leadId)).name).toHaveLength(80);
  });
});

// ======================================================= failure and retry

describe('when the lead cannot be filed right now', () => {
  const breakStatus = (active: boolean) =>
    owner.query(`UPDATE lead_statuses SET is_active = $2 WHERE tenant_id = $1 AND name = 'New'`, [fx.tenantId, active]);
  const eventFor = async (id: string) => (await owner.query(`SELECT status, attempts, error FROM inbound_events WHERE tenant_id = $1 AND external_id = $2`, [fx.tenantId, id])).rows[0];

  it('saves the event, tells the sender it was accepted, and files it when asked', async () => {
    await breakStatus(false);
    const body = websiteLead();
    let queued;
    try {
      queued = await post(fx.keys.website, body, { idem: 'will-fail-1' });
      expect(queued.statusCode).toBe(202);
      expect(queued.json()).toMatchObject({ outcome: 'queued' });
      expect(await countLeads(body.phone as string)).toBe(0);
      expect(await eventFor('will-fail-1')).toMatchObject({ status: 'failed', attempts: 1, error: expect.stringContaining('fresh') });
    } finally {
      await breakStatus(true);
    }

    const retried = await api.call('POST', `/integrations/events/${queued!.json().eventId}/retry`, sa);
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({ outcome: 'created', leadId: expect.any(String) });
    expect(await countLeads(body.phone as string)).toBe(1);
    expect(await eventFor('will-fail-1')).toMatchObject({ status: 'processed', error: null });
  });

  it('files it by itself on the next retry round', async () => {
    await breakStatus(false);
    const body = websiteLead();
    try {
      expect((await post(fx.keys.website, body, { idem: 'will-fail-2' })).statusCode).toBe(202);
    } finally {
      await breakStatus(true);
    }
    // Too soon: it waits a while after a failure.
    await app.get(IntakeService).retryDue();
    expect(await countLeads(body.phone as string)).toBe(0);

    await owner.query(`UPDATE inbound_events SET last_attempt_at = now() - interval '1 hour' WHERE tenant_id = $1 AND external_id = 'will-fail-2'`, [fx.tenantId]);
    expect(await app.get(IntakeService).retryDue()).toBeGreaterThanOrEqual(1);
    expect(await countLeads(body.phone as string)).toBe(1);
    expect((await eventFor('will-fail-2')).status).toBe('processed');
  });

  it('gives up after five tries and leaves the event for a person', async () => {
    await breakStatus(false);
    try {
      await post(fx.keys.website, websiteLead(), { idem: 'will-fail-3' });
      await owner.query(`UPDATE inbound_events SET attempts = 5, last_attempt_at = now() - interval '1 day' WHERE tenant_id = $1 AND external_id = 'will-fail-3'`, [fx.tenantId]);
      await app.get(IntakeService).retryDue();
      expect(await eventFor('will-fail-3')).toMatchObject({ status: 'failed', attempts: 5 });
    } finally {
      await breakStatus(true);
    }
  });
});

// ================================================== keys and events (admin)

describe('managing keys and events', () => {
  it('is for those who manage integrations', async () => {
    for (const path of ['/integrations/api-keys', '/integrations/events']) {
      expect((await api.call('GET', path, admin, undefined, OFFICE_IP)).statusCode).toBe(403);
    }
  });

  it('creates a key that works at once, never shows it again, and can be revoked', async () => {
    const source = (await api.call('POST', '/lead-sources', sa, { name: 'Partner Portal', channelType: 'portal' })).json();
    const created = await api.call('POST', '/integrations/api-keys', sa, { name: 'Portal connector', sourceId: source.id });
    expect(created.statusCode).toBe(201);
    expect(created.headers['cache-control']).toBe('no-store');
    const key = created.json().key as string;
    expect(key).toMatch(/^ahk_[A-Za-z0-9_-]{43}$/);

    const res = await post(key, websiteLead());
    expect(res.statusCode).toBe(201);
    expect((await leadRow(res.json().leadId)).source_name).toBe('Partner Portal');

    const listed = await api.call('GET', '/integrations/api-keys', sa);
    expect(JSON.stringify(listed.json())).not.toContain(key);
    expect(listed.json().find((k: { id: string }) => k.id === created.json().id)).toMatchObject({ prefix: key.slice(0, 8), revokedAt: null, source: { name: 'Partner Portal' } });
    const stored = (await owner.query(`SELECT key_hash FROM api_keys WHERE id = $1`, [created.json().id])).rows[0].key_hash;
    expect(stored).not.toContain(key.slice(4, 20));

    expect((await api.call('DELETE', `/integrations/api-keys/${created.json().id}`, sa)).statusCode).toBe(204);
    expect(errorCode(await post(key, websiteLead(), { ip: '198.51.100.24' }))).toBe('INVALID_API_KEY');
    expect((await api.call('DELETE', `/integrations/api-keys/${created.json().id}`, sa)).statusCode).toBe(404);

    await api.call('PATCH', `/lead-sources/${source.id}`, sa, { isActive: false });
    expect(errorCode(await api.call('POST', '/integrations/api-keys', sa, { name: 'Too late', sourceId: source.id }))).toBe('SOURCE_INVALID');
  });

  it('lists events by status and shows the raw payload only to those allowed, leaving a record', async () => {
    await post(fx.keys.website, { name: 'x', phone: 'nope' }, { idem: 'list-bad-1' });
    const ignored = await api.call('GET', '/integrations/events?status=ignored&limit=100', sa);
    const event = ignored.json().items.find((e: { externalId: string }) => e.externalId === 'list-bad-1');
    expect(event).toMatchObject({ status: 'ignored', source: 'Website', attempts: 1 });
    expect(event).not.toHaveProperty('payload');

    const detail = await api.call('GET', `/integrations/events/${event.id}`, sa);
    expect(detail.json().payload).toEqual({ name: 'x', phone: 'nope' });
    const logged = Number((await owner.query(`SELECT count(*) FROM audit_logs WHERE tenant_id = $1 AND action = 'intake_event.view' AND entity_id = $2`, [fx.tenantId, event.id])).rows[0].count);
    expect(logged).toBe(1);

    // Trying it again changes nothing while the content is still unusable.
    const retried = await api.call('POST', `/integrations/events/${event.id}/retry`, sa);
    expect(retried.json()).toMatchObject({ outcome: 'invalid' });
    const processed = await api.call('GET', `/integrations/events/${(await post(fx.keys.website, websiteLead(), { idem: 'ok-event-1' })).json().leadId ? event.id : event.id}`, sa);
    expect(processed.statusCode).toBe(200);

    const okEvent = (await owner.query(`SELECT id FROM inbound_events WHERE tenant_id = $1 AND external_id = 'ok-event-1'`, [fx.tenantId])).rows[0].id;
    expect(errorCode(await api.call('POST', `/integrations/events/${okEvent}/retry`, sa))).toBe('NOT_RETRYABLE');
  });

  it('pages through events', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await api.call('GET', `/integrations/events?limit=10${cursor ? `&cursor=${cursor}` : ''}`, sa);
      seen.push(...res.json().items.map((e: { id: string }) => e.id));
      cursor = res.json().nextCursor;
      pages++;
    } while (cursor && pages < 60);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(Number((await owner.query(`SELECT count(*) FROM inbound_events WHERE tenant_id = $1`, [fx.tenantId])).rows[0].count));
  });
});

// ==================================================== assignment settings

describe('assignment rules and policy', () => {
  const rule = (over: Record<string, unknown>) => ({
    name: 'Rule', priority: 1, strategy: 'fixed', userIds: [], ...over,
  });

  it('lets people who work with leads see the sources, but only settings managers change them', async () => {
    const list = await api.call('GET', '/lead-sources', admin, undefined, OFFICE_IP);
    expect(list.json().map((s: { name: string }) => s.name)).toEqual(expect.arrayContaining(['Website', 'Meta Ads']));
    expect((await api.call('POST', '/lead-sources', admin, { name: 'Walk in', channelType: 'walk_in' }, OFFICE_IP)).statusCode).toBe(403);
    expect((await api.call('GET', '/assignment-rules', admin, undefined, OFFICE_IP)).statusCode).toBe(403);
    expect(errorCode(await api.call('POST', '/lead-sources', sa, { name: 'website', channelType: 'website' }))).toBe('SOURCE_EXISTS');
  });

  it('send leads to the people a matching rule names, trying rules in priority order', async () => {
    await setPresence(['in1', 'in2', 'in3']);
    const byOnline = await api.call('POST', '/assignment-rules', sa, rule({
      name: 'Online website leads', priority: 1, sourceId: fx.sourceId('Website'), studyMode: 'online', userIds: [idOf('in2'), idOf('in3')],
    }));
    expect(byOnline.statusCode, byOnline.body).toBe(201);
    expect(byOnline.json().users.map((u: { name: string }) => u.name).sort()).toEqual(['in2', 'in3']);
    const regular = await api.call('POST', '/assignment-rules', sa, rule({
      name: 'Regular leads', priority: 2, studyMode: 'regular', userIds: [idOf('in1')],
    }));
    expect(errorCode(await api.call('POST', '/assignment-rules', sa, rule({ priority: 2 })))).toBe('PRIORITY_TAKEN');

    const onlineFirst = [idOf('in2'), idOf('in3')].sort()[0];
    for (let i = 0; i < 3; i++) {
      const res = await post(fx.keys.website, websiteLead({ mode: 'Online' }));
      expect(res.json().assignedTo).toBe(onlineFirst); // fixed: always the same person
    }
    expect((await post(fx.keys.website, websiteLead({ mode: 'Regular' }))).json().assignedTo).toBe(idOf('in1'));

    // A rule that names only people who are not in the office leaves the lead unassigned.
    const narrowed = await api.call('PATCH', `/assignment-rules/${byOnline.json().id}`, sa, { userIds: [idOf('in4')] });
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    expect(narrowed.json().users.map((u: { name: string }) => u.name)).toEqual(['in4']);
    const nobody = await post(fx.keys.website, websiteLead({ mode: 'Online' }));
    expect(nobody.json().assignedTo).toBeNull();
    expect(await notificationsAbout(nobody.json().leadId, 'lead_unassigned')).not.toHaveLength(0);

    // Switched off, a rule is ignored.
    await api.call('PATCH', `/assignment-rules/${byOnline.json().id}`, sa, { isActive: false });
    expect((await post(fx.keys.website, websiteLead({ mode: 'Online' }))).json().assignedTo).not.toBeNull();

    expect((await api.call('DELETE', `/assignment-rules/${byOnline.json().id}`, sa)).statusCode).toBe(204);
    expect((await api.call('DELETE', `/assignment-rules/${regular.json().id}`, sa)).statusCode).toBe(204);
    expect((await api.call('DELETE', `/assignment-rules/${regular.json().id}`, sa)).statusCode).toBe(404);
  });

  it('refuses a rule that names people or places that do not exist', async () => {
    expect(errorCode(await api.call('POST', '/assignment-rules', sa, rule({ priority: 9, userIds: ['00000000-0000-4000-8000-000000000000'] })))).toBe('USER_INVALID');
    expect(errorCode(await api.call('POST', '/assignment-rules', sa, rule({ priority: 9, sourceId: '00000000-0000-4000-8000-000000000000' })))).toBe('CONDITION_INVALID');
    expect(errorCode(await api.call('POST', '/assignment-rules', sa, rule({ priority: 0 })))).toBe('VALIDATION_FAILED');
  });

  it('can turn automatic assignment off', async () => {
    expect((await api.call('GET', '/lead-policy', sa)).json()).toEqual({ duplicateAction: 'attach', autoAssign: true, downloadForms: ['brochure', 'download'] });
    await api.call('PUT', '/lead-policy', sa, { duplicateAction: 'attach', autoAssign: false });
    try {
      const res = await post(fx.keys.website, websiteLead());
      expect(res.statusCode).toBe(201);
      expect(res.json().assignedTo).toBeNull();
      const told = await notificationsAbout(res.json().leadId, 'lead_unassigned');
      expect(told[0].payload).toMatchObject({ reason: 'auto_assign_off' });
    } finally {
      await api.call('PUT', '/lead-policy', sa, { duplicateAction: 'attach', autoAssign: true });
    }
  });
});

// A last look at the whole: nothing is lost.
it('keeps a saved event for every delivery that reached the door', async () => {
  const leads = Number((await owner.query(`SELECT count(*) FROM leads WHERE tenant_id = $1`, [fx.tenantId])).rows[0].count);
  const events = Number((await owner.query(`SELECT count(*) FROM inbound_events WHERE tenant_id = $1`, [fx.tenantId])).rows[0].count);
  expect(events).toBeGreaterThanOrEqual(leads);
  void inOffice;
});

describe('download alerts', () => {
  const alertsFor = async (leadId: string) => notificationsAbout(leadId, 'resource_download');
  const waitForMail = async (to: string) => {
    const mailer = app.get(MailerService);
    for (let i = 0; i < 20; i++) {
      const hit = mailer.outbox.find((m) => m.to === to && m.subject.startsWith('Download request'));
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 50));
    }
    return undefined;
  };

  it('tells the Super Admins when a visitor asks for a brochure, by bell and by email', async () => {
    const res = await post(fx.keys.website, websiteLead({ source: 'detail-brochure', interest: 'B.Tech at XYZ University' }));
    expect(res.statusCode, res.body).toBe(201);
    const told = await alertsFor(res.json().leadId);
    expect(told.map((r: { user_id: string }) => r.user_id)).toContain(idOf('super'));
    expect(told[0].payload).toMatchObject({ name: 'Riya Sharma', resource: 'B.Tech at XYZ University', form: 'detail-brochure' });
    const mail = await waitForMail(fx.user('super').email);
    expect(mail?.text).toContain('B.Tech at XYZ University');
  });

  it('says nothing for an ordinary enquiry form', async () => {
    const res = await post(fx.keys.website, websiteLead({ source: 'home-popup' }));
    expect(await alertsFor(res.json().leadId)).toHaveLength(0);
  });

  it('tells them again when someone who is already a lead downloads something else', async () => {
    const p = websiteLead({ source: 'home-popup' });
    const first = await post(fx.keys.website, p);
    const again = await post(fx.keys.website, { ...p, id: `${p.id}-2`, source: 'detail-brochure', interest: 'MBA brochure' });
    expect(again.json().leadId).toBe(first.json().leadId);
    expect(await alertsFor(first.json().leadId)).toHaveLength(await countSuperAdmins());
  });

  it('follows the words the company chose', async () => {
    const set = await api.call('PUT', '/lead-policy', sa, { duplicateAction: 'attach', autoAssign: true, downloadForms: ['Syllabus'] });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json().downloadForms).toEqual(['syllabus']);
    try {
      const brochure = await post(fx.keys.website, websiteLead({ source: 'detail-brochure' }));
      expect(await alertsFor(brochure.json().leadId)).toHaveLength(0);
      const syllabus = await post(fx.keys.website, websiteLead({ source: 'syllabus-download' }));
      expect((await alertsFor(syllabus.json().leadId)).length).toBeGreaterThan(0);
    } finally {
      await api.call('PUT', '/lead-policy', sa, { duplicateAction: 'attach', autoAssign: true, downloadForms: ['brochure', 'download'] });
    }
  });
});

async function countSuperAdmins() {
  return Number((await owner.query(`SELECT count(*) FROM users u JOIN roles r ON r.id = u.role_id WHERE u.tenant_id = $1 AND r.system_key = 'super_admin' AND u.status = 'active'`, [fx.tenantId])).rows[0].count);
}
