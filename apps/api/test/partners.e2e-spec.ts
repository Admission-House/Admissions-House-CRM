import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { startApp } from './helpers/app.js';
import { Client, makeClient } from './helpers/client.js';
import { createFixture, Fixture } from './helpers/fixtures.js';

/** Sending a lead to a partner college, against a stand-in for the college's server. */
let app: NestFastifyApplication;
let bare: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;
let api: Client;
let college: Server;
let url = '';
const t: Record<string, string> = {};
const SECRET = 'test-secret-key-0123456789';

interface Call { headers: IncomingMessage['headers']; body: Record<string, string> }
const calls: Call[] = [];
let answer: { status: number; body: string; delayMs: number } = { status: 200, body: '{"status":true,"message":"Lead created"}', delayMs: 0 };

beforeAll(async () => {
  college = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      calls.push({ headers: req.headers, body: JSON.parse(raw || '{}') as Record<string, string> });
      setTimeout(() => {
        res.writeHead(answer.status, { 'content-type': 'application/json' });
        res.end(answer.body);
      }, answer.delayMs);
    });
  });
  await new Promise<void>((r) => college.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(college.address() as { port: number }).port}/dataporting/382/admissions_house`;

  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  app = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500', PARTNER_UAU_SECRET_KEY: SECRET, PARTNER_UAU_URL: url });
  bare = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500', PARTNER_UAU_SECRET_KEY: undefined, PARTNER_UAU_URL: url });
  api = makeClient(app, fx);
  t.sa = await api.signIn('super');
  t.lc1 = await api.signIn('lc1', { office: true });
  t.lc2 = await api.signIn('lc2', { office: true });
});

afterAll(async () => {
  await app?.close();
  await bare?.close();
  await new Promise((r) => college?.close(r));
  await fx?.cleanup();
  await owner?.end();
});

beforeEach(() => {
  calls.length = 0;
  answer = { status: 200, body: '{"status":true,"message":"Lead created"}', delayMs: 0 };
});

let counter = 0;
const phone = () => `9${String(300_000_000 + ++counter).padStart(9, '0')}`;
async function lead(token = t.lc1!, email: string | null = 'student@example.com') {
  const res = await api.call('POST', '/leads', token, { name: 'College Lead', phone: phone(), sourceId: fx.sourceId('Website'), ...(email && { email }) });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string };
}
const choice = { course: 'MBA Single Specialization', specialization: 'Marketing', state: 'Delhi', city: 'Central Delhi' };
const sendTo = (token: string, id: string, body: Record<string, unknown> = choice) => api.call('POST', `/leads/${id}/partners/universal-ai/send`, token, body);
const code = (r: { json: () => { error?: { code?: string } } }) => r.json().error?.code;

describe('what a counsellor can see', () => {
  it('lists the college with its courses and states, says it is set up, and never shows the key', async () => {
    const res = await api.call('GET', '/partners', t.lc1!);
    expect(res.statusCode).toBe(200);
    const [p] = res.json();
    expect(p).toMatchObject({ key: 'universal-ai', name: 'Universal AI University', configured: true });
    expect(p.programs.length).toBe(7);
    expect(p.states.length).toBe(37);
    expect(res.body).not.toContain(SECRET);
  });

  it('lists the cities of a state, and nothing for an unknown state', async () => {
    const cities = (await api.call('GET', '/partners/universal-ai/cities?state=Delhi', t.lc1!)).json();
    expect(cities).toContain('Central Delhi');
    expect((await api.call('GET', '/partners/universal-ai/cities?state=Atlantis', t.lc1!)).json()).toEqual([]);
    expect((await api.call('GET', '/partners/not-a-college/cities?state=Delhi', t.lc1!)).statusCode).toBe(404);
  });
});

describe('sending a lead', () => {
  it('sends the details the college asked for, records it on the lead, and keeps the key out of everything stored', async () => {
    const l = await lead();
    const res = await sendTo(t.lc1!, l.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, message: 'Lead created' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers['content-type']).toContain('application/json');
    expect(calls[0]!.body).toMatchObject({
      secret_key: SECRET, source: 'admissions_house', college_id: '382', name: 'College Lead', email: 'student@example.com',
      state: 'Delhi', city: 'Central Delhi', campus: 'PG', course: 'MBA Single Specialization', specialization: 'Marketing', medium: 'CRM', campaign: 'Website',
    });
    expect(calls[0]!.body.mobile).toMatch(/^\d{10}$/);

    const list = (await api.call('GET', `/leads/${l.id}/partner-submissions`, t.lc1!)).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ partnerName: 'Universal AI University', state: 'sent', course: 'MBA Single Specialization', specialization: 'Marketing' });
    expect(JSON.stringify(list)).not.toContain(SECRET);

    const stored = (await owner.query(`SELECT request::text AS r, response FROM lead_partner_submissions WHERE lead_id = $1`, [l.id])).rows[0];
    expect(stored.r).not.toContain(SECRET);
    expect(stored.r).not.toContain('secret_key');

    const history = (await api.call('GET', `/leads/${l.id}`, t.lc1!)).json();
    const activity = (await owner.query(`SELECT remark FROM lead_activities WHERE lead_id = $1 AND type = 'partner'`, [l.id])).rows;
    expect(activity).toHaveLength(1);
    expect(activity[0].remark).toContain('Universal AI University');
    expect(history.id).toBe(l.id);
  });

  it('will not send the same student twice by accident, but will when told to', async () => {
    const l = await lead();
    expect((await sendTo(t.lc1!, l.id)).statusCode).toBe(200);
    const again = await sendTo(t.lc1!, l.id);
    expect(again.statusCode).toBe(409);
    expect(code(again)).toBe('ALREADY_SENT');
    expect(calls).toHaveLength(1);
    expect((await sendTo(t.lc1!, l.id, { ...choice, resend: true })).statusCode).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it('stops a double click: two sends at once make one call to the college', async () => {
    const l = await lead();
    answer = { status: 200, body: '{"status":true}', delayMs: 400 };
    const [a, b] = await Promise.all([sendTo(t.lc1!, l.id), sendTo(t.lc1!, l.id)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(calls).toHaveLength(1);
  });

  it('refuses a choice that is not on the college\'s lists, before anything leaves the CRM', async () => {
    const l = await lead();
    for (const bad of [{ ...choice, course: 'B.Tech' }, { ...choice, specialization: 'International Business' }, { ...choice, state: 'Atlantis' }, { ...choice, city: 'Mumbai' }]) {
      const res = await sendTo(t.lc1!, l.id, bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(code(res)).toBe('INVALID_CHOICE');
    }
    expect(calls).toHaveLength(0);
  });

  it('needs the student\'s email address', async () => {
    const l = await lead(t.lc1!, null);
    const res = await sendTo(t.lc1!, l.id);
    expect(res.statusCode).toBe(400);
    expect(code(res)).toBe('EMAIL_REQUIRED');
    expect(calls).toHaveLength(0);
  });

  it('reports the college refusing a lead, keeps it as failed, and lets the counsellor try again without forcing', async () => {
    const l = await lead();
    answer = { status: 200, body: '{"status":false,"message":"Duplicate lead"}', delayMs: 0 };
    const res = await sendTo(t.lc1!, l.id);
    expect(res.json()).toMatchObject({ ok: false, message: 'Duplicate lead' });
    const list = (await api.call('GET', `/leads/${l.id}/partner-submissions`, t.lc1!)).json();
    expect(list[0]).toMatchObject({ state: 'failed', message: 'Duplicate lead' });
    expect((await owner.query(`SELECT count(*)::int n FROM lead_activities WHERE lead_id = $1 AND type = 'partner'`, [l.id])).rows[0].n).toBe(0);
    answer = { status: 200, body: '{"status":true}', delayMs: 0 };
    expect((await sendTo(t.lc1!, l.id)).json()).toMatchObject({ ok: true });
  });

  it('reports an error from the college as a failure and does not log it as sent', async () => {
    const l = await lead();
    answer = { status: 500, body: 'Internal error', delayMs: 0 };
    const res = await sendTo(t.lc1!, l.id);
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
    expect((await api.call('GET', `/leads/${l.id}/partner-submissions`, t.lc1!)).json()[0].state).toBe('failed');
  });

  it('says so when the college cannot be reached', async () => {
    const l = await lead();
    const dead = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500', PARTNER_UAU_SECRET_KEY: SECRET, PARTNER_UAU_URL: 'http://127.0.0.1:9/none' });
    try {
      const c = makeClient(dead, fx);
      const token = await c.signIn('lc1', { office: true });
      const res = await c.call('POST', `/leads/${l.id}/partners/universal-ai/send`, token, choice);
      expect(res.json()).toMatchObject({ ok: false, message: 'Could not reach Universal AI University.' });
    } finally {
      await dead.close();
    }
  });

  it('says it is not set up when the college\'s key has not been added', async () => {
    const l = await lead();
    const c = makeClient(bare, fx);
    const token = await c.signIn('lc1', { office: true });
    const res = await c.call('POST', `/leads/${l.id}/partners/universal-ai/send`, token, choice);
    expect(res.statusCode).toBe(503);
    expect(code(res)).toBe('PARTNER_NOT_SET');
    expect((await c.call('GET', '/partners', token)).json()[0].configured).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('who may send', () => {
  it('lets a counsellor send only their own lead; another person\'s lead is not found', async () => {
    const mine = await lead(t.lc1!);
    expect((await sendTo(t.lc2!, mine.id)).statusCode).toBe(404);
    expect((await api.call('GET', `/leads/${mine.id}/partner-submissions`, t.lc2!)).statusCode).toBe(404);
    expect(calls).toHaveLength(0);
    expect((await sendTo(t.sa!, mine.id)).statusCode).toBe(200);
  });

  it('refuses someone who is not signed in', async () => {
    const l = await lead();
    const res = await app.inject({ method: 'POST', url: `/api/v1/leads/${l.id}/partners/universal-ai/send`, payload: choice, remoteAddress: '198.51.100.9' });
    expect(res.statusCode).toBe(401);
  });
});

describe('erasing a student', () => {
  it('removes the copy of their details that was kept with each submission', async () => {
    const l = await lead();
    expect((await sendTo(t.lc1!, l.id)).statusCode).toBe(200);
    expect((await owner.query(`SELECT count(*)::int n FROM lead_partner_submissions WHERE lead_id = $1`, [l.id])).rows[0].n).toBe(1);
    const erase = await api.call('POST', `/leads/${l.id}/erase`, t.sa!);
    expect(erase.statusCode, erase.body).toBe(200);
    expect((await owner.query(`SELECT count(*)::int n FROM lead_partner_submissions WHERE lead_id = $1`, [l.id])).rows[0].n).toBe(0);
  });
});

describe('DNP with a college', () => {
  it('marks a sent lead as DNP, shows it next to the college, and moves it back', async () => {
    const l = await lead();
    const sent = await sendTo(t.lc1!, l.id);
    const id = sent.json().submissionId as string;
    expect((await api.call('GET', `/leads/${l.id}/partner-submissions`, t.lc1!)).json()[0].dnp).toBeNull();

    const short = await api.call('POST', `/leads/${l.id}/partner-submissions/${id}/dnp`, t.lc1!, { reason: 'x' });
    expect(short.statusCode).toBe(400); // a reason of at least 3 letters
    const marked = await api.call('POST', `/leads/${l.id}/partner-submissions/${id}/dnp`, t.lc1!, { reason: 'Did not pick up three times' });
    expect(marked.statusCode, marked.body).toBe(200);
    const after = (await api.call('GET', `/leads/${l.id}/partner-submissions`, t.lc1!)).json()[0];
    expect(after.dnp).toMatchObject({ reason: 'Did not pick up three times' });
    expect((await api.call('POST', `/leads/${l.id}/partner-submissions/${id}/dnp`, t.lc1!, { reason: 'again again' })).statusCode).toBe(404); // already DNP

    expect((await api.call('DELETE', `/leads/${l.id}/partner-submissions/${id}/dnp`, t.lc1!)).statusCode).toBe(200);
    expect((await api.call('GET', `/leads/${l.id}/partner-submissions`, t.lc1!)).json()[0].dnp).toBeNull();
  });

  it('only for a lead that was sent, and only by someone who may see the lead', async () => {
    const l = await lead();
    answer = { status: 200, body: '{"status":false,"message":"Duplicate lead"}', delayMs: 0 };
    const failed = (await sendTo(t.lc1!, l.id)).json().submissionId as string;
    expect((await api.call('POST', `/leads/${l.id}/partner-submissions/${failed}/dnp`, t.lc1!, { reason: 'not sent really' })).statusCode).toBe(404);
    answer = { status: 200, body: '{"status":true}', delayMs: 0 };
    const ok = (await sendTo(t.lc1!, l.id, { ...choice, resend: true })).json().submissionId as string;
    expect((await api.call('POST', `/leads/${l.id}/partner-submissions/${ok}/dnp`, t.lc2!, { reason: 'someone else' })).statusCode).toBe(404);
  });
});
