import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { startApp } from './helpers/app.js';
import { Client, makeClient } from './helpers/client.js';
import { createFixture, Fixture, OFFICE_IP } from './helpers/fixtures.js';

let app: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;
let api: Client;
const t: Record<string, string> = {};
let seq = 0;

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  app = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500' });
  api = makeClient(app, fx);
  t.sa = await api.signIn('super');
  t.admin = await api.signIn('admin', { office: true });
  t.lc = await api.signIn('counsellor', { office: true });
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.end();
});

const status = async (open: boolean) =>
  (await owner.query(`SELECT id FROM lead_statuses WHERE tenant_id = $1 AND is_open = $2 ORDER BY sort_order LIMIT 1`, [fx.tenantId, open])).rows[0].id as string;

/** Puts a lead straight into the database, held by `holder`. */
async function giveLead(holder: string, open = true): Promise<string> {
  const n = ++seq;
  const { rows } = await owner.query(
    `INSERT INTO leads (tenant_id, lead_no, name, primary_phone, status_id, source_id, assigned_to, assigned_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now()) RETURNING id`,
    [fx.tenantId, 9_000_000 + n, `Transfer Lead ${n}`, `9199${String(10_000_000 + n)}`, await status(open), fx.sourceId('Website'), fx.user(holder).id],
  );
  return rows[0].id as string;
}

const holders = async (ids: string[]) =>
  (await owner.query(`SELECT id, assigned_to FROM leads WHERE id = ANY($1::uuid[])`, [ids])).rows as { id: string; assigned_to: string | null }[];
const transfer = (token: string, body: Record<string, unknown>, ip?: string) => api.call('POST', '/leads/transfer', token, body, ip);
const errorCode = (res: { json: () => { error?: { code?: string } } }) => res.json().error?.code;
const autoFlag = async (who: string) => (await owner.query(`SELECT receives_auto_leads AS v FROM users WHERE id = $1`, [fx.user(who).id])).rows[0].v as boolean;

describe('moving a person\'s leads to others', () => {
  it('shares the open leads evenly among the chosen people, leaves closed ones, and writes the history', async () => {
    const open = [await giveLead('counsellor'), await giveLead('counsellor'), await giveLead('counsellor'), await giveLead('counsellor')];
    const closed = await giveLead('counsellor', false);

    const res = await transfer(t.sa!, { fromUserId: fx.user('counsellor').id, toUserIds: [fx.user('mobile').id, fx.user('perms').id], allowUnavailable: true });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ moved: expect.any(Number), remaining: 0, pausedAutomation: false });
    expect(body.moved).toBeGreaterThanOrEqual(4);
    expect(body.to.map((x: { leads: number }) => x.leads).reduce((a: number, b: number) => a + b, 0)).toBe(body.moved);
    expect(Math.abs(body.to[0].leads - body.to[1].leads)).toBeLessThanOrEqual(1);

    const now = await holders([...open, closed]);
    for (const id of open) expect([fx.user('mobile').id, fx.user('perms').id]).toContain(now.find((x) => x.id === id)!.assigned_to);
    expect(now.find((x) => x.id === closed)!.assigned_to).toBe(fx.user('counsellor').id); // closed leads stay

    const history = await owner.query(`SELECT count(*)::int AS n FROM lead_activities WHERE tenant_id = $1 AND lead_id = $2 AND type = 'assignment'`, [fx.tenantId, open[0]]);
    expect(history.rows[0].n).toBeGreaterThanOrEqual(1);
    const audit = await owner.query(`SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND action = 'lead.transfer'`, [fx.tenantId]);
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('can move every lead, closed ones too', async () => {
    const a = await giveLead('mobile', false);
    const res = await transfer(t.sa!, { fromUserId: fx.user('mobile').id, toUserIds: [fx.user('perms').id], which: 'all', allowUnavailable: true });
    expect(res.statusCode, res.body).toBe(200);
    expect((await holders([a]))[0]!.assigned_to).toBe(fx.user('perms').id);
  });

  it('refuses a person who is not working today unless that is confirmed, and moves nothing', async () => {
    const lead = await giveLead('perms');
    const res = await transfer(t.sa!, { fromUserId: fx.user('perms').id, toUserIds: [fx.user('mobile').id] });
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('ASSIGNEE_UNAVAILABLE');
    expect((await holders([lead]))[0]!.assigned_to).toBe(fx.user('perms').id);
  });

  it('will not move leads onto the same person', async () => {
    const res = await transfer(t.sa!, { fromUserId: fx.user('perms').id, toUserIds: [fx.user('perms').id], allowUnavailable: true });
    expect(errorCode(res)).toBe('TRANSFER_TO_SELF');
  });

  it('keeps an Admin inside their own team', async () => {
    const lead = await giveLead('counsellor2');
    // counsellor2 belongs to admin2: the Admin cannot take from them, nor give to them.
    const take = await transfer(t.admin!, { fromUserId: fx.user('counsellor2').id, toUserIds: [fx.user('counsellor').id], allowUnavailable: true }, OFFICE_IP);
    expect(take.statusCode).toBe(404);
    const give = await transfer(t.admin!, { fromUserId: fx.user('perms').id, toUserIds: [fx.user('counsellor2').id], allowUnavailable: true }, OFFICE_IP);
    expect(errorCode(give)).toBe('ASSIGNEE_INVALID');
    expect((await holders([lead]))[0]!.assigned_to).toBe(fx.user('counsellor2').id);
  });

  it('is for people who hand out leads, not for counsellors', async () => {
    const res = await transfer(t.lc!, { fromUserId: fx.user('counsellor').id, toUserIds: [fx.user('mobile').id], allowUnavailable: true }, OFFICE_IP);
    expect(res.statusCode).toBe(403);
  });
});

describe('the switch for automatic leads', () => {
  const website = (name: string) =>
    app.inject({
      method: 'POST', url: '/api/v1/intake/leads', remoteAddress: '203.0.113.20',
      headers: { authorization: `Bearer ${fx.keys.website}`, 'content-type': 'application/json' },
      payload: { name, phone: `9188${String(20_000_000 + ++seq)}` },
    });
  const assignedTo = async (leadId: string) => (await owner.query(`SELECT assigned_to FROM leads WHERE id = $1`, [leadId])).rows[0].assigned_to as string | null;

  it('is on for everyone to begin with, and shows on the person', async () => {
    expect(await autoFlag('counsellor')).toBe(true);
    const view = await api.call('GET', `/users/${fx.user('counsellor').id}`, t.sa!);
    expect(view.json().receivesAutoLeads).toBe(true);
  });

  it('gives a new lead to a working counsellor while it is on, and not once it is off', async () => {
    // "counsellor" is signed in at the office today; nobody else is.
    const first = await website('Switch On');
    expect(first.statusCode, first.body).toBe(201);
    expect(await assignedTo(first.json().leadId)).toBe(fx.user('counsellor').id);

    const off = await api.call('PUT', `/users/${fx.user('counsellor').id}/lead-automation`, t.admin!, { enabled: false }, OFFICE_IP);
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().receivesAutoLeads).toBe(false);

    const second = await website('Switch Off');
    expect(second.statusCode, second.body).toBe(201);
    expect(await assignedTo(second.json().leadId)).toBeNull(); // waits for an Admin to hand it out

    // They can still be given a lead by hand.
    const byHand = await api.call('POST', `/leads/${second.json().leadId}/assign`, t.admin!, { userId: fx.user('counsellor').id }, OFFICE_IP);
    expect(byHand.statusCode, byHand.body).toBe(200);

    await api.call('PUT', `/users/${fx.user('counsellor').id}/lead-automation`, t.admin!, { enabled: true }, OFFICE_IP);
    const third = await website('Switch On Again');
    expect(await assignedTo(third.json().leadId)).toBe(fx.user('counsellor').id);
  });

  it('can be turned off together with a transfer', async () => {
    await giveLead('counsellor');
    const res = await transfer(t.sa!, { fromUserId: fx.user('counsellor').id, toUserIds: [fx.user('mobile').id], pauseAutomation: true, allowUnavailable: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().pausedAutomation).toBe(true);
    expect(await autoFlag('counsellor')).toBe(false);
    await owner.query(`UPDATE users SET receives_auto_leads = true WHERE id = $1`, [fx.user('counsellor').id]);
  });

  it('is recorded in the audit log, and kept inside the Admin\'s team', async () => {
    const outside = await api.call('PUT', `/users/${fx.user('counsellor2').id}/lead-automation`, t.admin!, { enabled: false }, OFFICE_IP);
    expect(outside.statusCode).toBe(404);
    const counsellor = await api.call('PUT', `/users/${fx.user('mobile').id}/lead-automation`, t.lc!, { enabled: false }, OFFICE_IP);
    expect(counsellor.statusCode).toBe(403);
    const audit = await owner.query(`SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND action = 'user.lead_automation'`, [fx.tenantId]);
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(2);
  });
});
