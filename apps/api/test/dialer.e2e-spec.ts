import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { startApp } from './helpers/app.js';
import { Client, makeClient } from './helpers/client.js';
import { createFixture, Fixture } from './helpers/fixtures.js';

let app: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;
let api: Client;
let webhookKey = '';
const t: Record<string, string> = {};

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  app = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500' });
  api = makeClient(app, fx);
  t.sa = await api.signIn('super');
  for (const name of ['admin', 'admin2', 'lc1', 'lc2']) t[name] = await api.signIn(name, { office: true });
  await owner.query(`UPDATE users SET phone = '9810000001' WHERE id = $1`, [fx.user('lc1').id]);
  webhookKey = (await api.call('PUT', '/telephony/connection', t.sa!, { provider: 'generic', config: { simulate: true } })).json().webhookKey;
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.end();
});

let counter = 0;
const phone = () => `9${String(400_000_000 + ++counter).padStart(9, '0')}`;
const errorCode = (res: { json: () => { error?: { code?: string } } }) => res.json().error?.code;
const statusId = async (name: string) => (await owner.query(`SELECT id FROM lead_statuses WHERE tenant_id = $1 AND name = $2`, [fx.tenantId, name])).rows[0].id as string;
const newLeads = async (n: number, token = t.lc1!) => {
  const out: { id: string; phone: string; name: string }[] = [];
  for (let i = 0; i < n; i++) {
    const p = phone();
    const res = await api.call('POST', '/leads', token, { name: `Dial ${counter}`, phone: p, sourceId: fx.sourceId('Website') });
    expect(res.statusCode, res.body).toBe(201);
    out.push({ id: res.json().id, phone: p, name: `Dial ${counter}` });
  }
  return out;
};
const start = (leads: { id: string }[], token = t.lc1!) => api.call('POST', '/dialer/sessions', token, { leadIds: leads.map((l) => l.id) });
const stopAny = async () => {
  const cur = await api.call('GET', '/dialer/sessions/current', t.lc1!);
  if (cur.json()) await api.call('POST', `/dialer/sessions/${cur.json().id}/stop`, t.lc1!);
  await owner.query(`UPDATE calls SET outcome = 'failed' WHERE tenant_id = $1 AND outcome IN ('requested', 'ringing')`, [fx.tenantId]);
};
/** The provider reports the call that was just placed. */
async function finishCall(callId: string, leadPhone: string, how: 'connected' | 'not_picked') {
  const pid = (await owner.query(`SELECT provider_call_id FROM calls WHERE id = $1`, [callId])).rows[0].provider_call_id;
  const at = new Date().toISOString();
  const events =
    how === 'connected'
      ? [{ event: 'answered' }, { event: 'ended', durationSec: 45 }]
      : [{ event: 'ended', outcome: 'not_picked' }];
  const res = await app.inject({
    method: 'POST', url: '/api/v1/telephony/webhook', headers: { authorization: `Bearer ${webhookKey}` },
    payload: { events: events.map((e) => ({ providerCallId: pid, direction: 'outgoing', customerNumber: leadPhone, at, ...e })) } as never,
  });
  expect(res.statusCode, res.body).toBe(200);
}

describe('starting a session', () => {
  afterEach(stopAny);

  it('lines up the leads in the order given', async () => {
    const leads = await newLeads(3);
    const res = await start([leads[2]!, leads[0]!, leads[1]!, leads[0]!]); // a repeat is counted once
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ status: 'running', user: { name: 'lc1' }, counts: { total: 3, pending: 3, called: 0, skipped: 0 }, current: { leadId: leads[2]!.id, state: 'pending' } });
    expect(res.json().leads.map((l: { leadId: string }) => l.leadId)).toEqual([leads[2]!.id, leads[0]!.id, leads[1]!.id]);
    expect((await api.call('GET', '/dialer/sessions/current', t.lc1!)).json().id).toBe(res.json().id);
  });

  it('allows one session at a time', async () => {
    const leads = await newLeads(2);
    const first = await start(leads);
    const second = await start(leads);
    expect(second.statusCode).toBe(409);
    expect(errorCode(second)).toBe('SESSION_ACTIVE');
    expect(second.json().error.details.sessionId).toBe(first.json().id);
  });

  it('refuses leads that are not the caller\'s to see, closed leads, and empty lists', async () => {
    const [mine] = await newLeads(1);
    const [theirs] = await newLeads(1, t.lc2!);
    expect((await start([mine!, theirs!])).statusCode).toBe(404);
    const [closed] = await newLeads(1);
    await owner.query(`UPDATE leads SET status_id = $1 WHERE id = $2`, [await statusId('Not Interested'), closed!.id]);
    const res = await start([mine!, closed!]);
    expect(res.statusCode).toBe(400);
    expect(errorCode(res)).toBe('LEAD_CLOSED');
    expect(errorCode(await api.call('POST', '/dialer/sessions', t.lc1!, { leadIds: [] }))).toBe('VALIDATION_FAILED');
    expect(await api.call('GET', '/dialer/sessions/current', t.lc1!).then((r) => r.json())).toBeNull(); // nothing was started by the failures
  });

  it('needs the dialer permission', async () => {
    const role = (await owner.query(`INSERT INTO roles (tenant_id, name, data_scope, requires_office) VALUES ($1, 'No Dialer', 'all', false) RETURNING id`, [fx.tenantId])).rows[0].id;
    await owner.query(`INSERT INTO role_permissions (tenant_id, role_id, permission_id) SELECT $1, $2, id FROM permissions WHERE code IN ('lead.read', 'call.place')`, [fx.tenantId, role]);
    await fx.addUser({ name: 'nodialer', roleId: role });
    const token = await api.signIn('nodialer');
    expect((await api.call('POST', '/dialer/sessions', token, { leadIds: [(await newLeads(1))[0]!.id] })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/dialer/sessions/current' })).statusCode).toBe(401);
  });
});

describe('working through a session', () => {
  afterEach(stopAny);

  it('calls each lead in turn and moves on after every outcome', async () => {
    const leads = await newLeads(3);
    const session = (await start(leads)).json();

    const first = await api.call('POST', `/dialer/sessions/${session.id}/dial`, t.lc1!);
    expect(first.statusCode, first.body).toBe(202);
    expect(first.json()).toMatchObject({ lead: { leadId: leads[0]!.id, state: 'called' }, call: { outcome: 'requested', lead: { id: leads[0]!.id } }, session: { counts: { pending: 2, called: 1 }, current: { leadId: leads[1]!.id } } });
    expect((await owner.query(`SELECT dialer_session_id FROM calls WHERE id = $1`, [first.json().call.id])).rows[0].dialer_session_id).toBe(session.id);

    // the next call has to wait until this one is over
    const tooSoon = await api.call('POST', `/dialer/sessions/${session.id}/dial`, t.lc1!);
    expect(errorCode(tooSoon)).toBe('CALL_IN_PROGRESS');
    expect((await api.call('GET', `/dialer/sessions/${session.id}`, t.lc1!)).json().counts).toMatchObject({ pending: 2, called: 1 });

    await finishCall(first.json().call.id, leads[0]!.phone, 'not_picked');
    const second = await api.call('POST', `/dialer/sessions/${session.id}/dial`, t.lc1!);
    expect(second.statusCode, second.body).toBe(202);
    expect(second.json().lead.leadId).toBe(leads[1]!.id);
  });

  it('asks for the after-call form after an answered call, then carries on', async () => {
    const leads = await newLeads(2);
    const session = (await start(leads)).json();
    const first = (await api.call('POST', `/dialer/sessions/${session.id}/dial`, t.lc1!)).json();
    await finishCall(first.call.id, leads[0]!.phone, 'connected');

    const blocked = await api.call('POST', `/dialer/sessions/${session.id}/dial`, t.lc1!);
    expect(blocked.statusCode).toBe(409);
    expect(errorCode(blocked)).toBe('WRAP_UP_REQUIRED');
    expect(blocked.json().error.details.callId).toBe(first.call.id);

    const wrapped = await api.call('POST', `/calls/${first.call.id}/wrap-up`, t.lc1!, { statusId: await statusId('Contacted'), remark: 'Interested' });
    expect(wrapped.statusCode, wrapped.body).toBe(200);
    const next = await api.call('POST', `/dialer/sessions/${session.id}/dial`, t.lc1!);
    expect(next.statusCode, next.body).toBe(202);
    expect(next.json().lead.leadId).toBe(leads[1]!.id);
  });

  it('skips a lead, and finishes by itself when none are left', async () => {
    const leads = await newLeads(2);
    const session = (await start(leads)).json();
    const skipped = await api.call('POST', `/dialer/sessions/${session.id}/skip`, t.lc1!);
    expect(skipped.json()).toMatchObject({ status: 'running', counts: { pending: 1, skipped: 1 }, current: { leadId: leads[1]!.id } });
    const last = await api.call('POST', `/dialer/sessions/${session.id}/skip`, t.lc1!);
    expect(last.json()).toMatchObject({ status: 'finished', counts: { pending: 0, skipped: 2 }, current: null });
    expect(last.json().endedAt).not.toBeNull();

    const more = await api.call('POST', `/dialer/sessions/${session.id}/dial`, t.lc1!);
    expect(more.statusCode).toBe(409);
    expect(errorCode(more)).toBe('SESSION_ENDED');
    expect((await api.call('GET', '/dialer/sessions/current', t.lc1!)).json()).toBeNull();
    expect((await start(leads)).statusCode).toBe(201); // free to start another
  });

  it('finishes after the last call is placed', async () => {
    const [only] = await newLeads(1);
    const session = (await start([only!])).json();
    const dialed = await api.call('POST', `/dialer/sessions/${session.id}/dial`, t.lc1!);
    expect(dialed.json().session).toMatchObject({ status: 'finished', counts: { pending: 0, called: 1 } });
  });

  it('does not place a call when the provider cannot, and keeps the lead for another try', async () => {
    await api.call('PUT', '/telephony/connection', t.sa!, { provider: 'generic', config: { simulate: false } });
    const leads = await newLeads(1);
    const session = (await start(leads)).json();
    const res = await api.call('POST', `/dialer/sessions/${session.id}/dial`, t.lc1!);
    expect(errorCode(res)).toBe('DIALING_NOT_AVAILABLE');
    expect((await api.call('GET', `/dialer/sessions/${session.id}`, t.lc1!)).json()).toMatchObject({ status: 'running', counts: { pending: 1, called: 0 } });
    await api.call('PUT', '/telephony/connection', t.sa!, { provider: 'generic', config: { simulate: true } });
  });
});

describe('pausing and stopping', () => {
  afterEach(stopAny);

  it('holds the dialing while paused and carries on when resumed', async () => {
    const leads = await newLeads(2);
    const session = (await start(leads)).json();
    const paused = await api.call('POST', `/dialer/sessions/${session.id}/pause`, t.lc1!);
    expect(paused.json().status).toBe('paused');
    const dial = await api.call('POST', `/dialer/sessions/${session.id}/dial`, t.lc1!);
    expect(errorCode(dial)).toBe('SESSION_PAUSED');
    expect(errorCode(await api.call('POST', `/dialer/sessions/${session.id}/pause`, t.lc1!))).toBe('SESSION_STATE');
    expect((await api.call('POST', `/dialer/sessions/${session.id}/resume`, t.lc1!)).json().status).toBe('running');
    expect((await api.call('POST', `/dialer/sessions/${session.id}/dial`, t.lc1!)).statusCode).toBe(202);
  });

  it('ends for good when stopped', async () => {
    const session = (await start(await newLeads(2))).json();
    const stopped = await api.call('POST', `/dialer/sessions/${session.id}/stop`, t.lc1!);
    expect(stopped.json()).toMatchObject({ status: 'stopped', current: null });
    expect(stopped.json().endedAt).not.toBeNull();
    expect(errorCode(await api.call('POST', `/dialer/sessions/${session.id}/stop`, t.lc1!))).toBe('SESSION_STATE');
    expect(errorCode(await api.call('POST', `/dialer/sessions/${session.id}/resume`, t.lc1!))).toBe('SESSION_STATE');
    expect(errorCode(await api.call('POST', `/dialer/sessions/${session.id}/dial`, t.lc1!))).toBe('SESSION_ENDED');
  });

  it('can be paused or stopped by an Admin of the team, who cannot dial for the counsellor', async () => {
    const session = (await start(await newLeads(2))).json();
    expect((await api.call('POST', `/dialer/sessions/${session.id}/pause`, t.admin!)).json().status).toBe('paused');
    expect((await api.call('GET', `/dialer/sessions/${session.id}`, t.admin!)).statusCode).toBe(200);
    expect((await api.call('GET', '/dialer/sessions?status=paused', t.admin!)).json().map((s: { id: string }) => s.id)).toContain(session.id);
    expect((await api.call('POST', `/dialer/sessions/${session.id}/resume`, t.admin!)).json().status).toBe('running');
    expect((await api.call('POST', `/dialer/sessions/${session.id}/dial`, t.admin!)).statusCode).toBe(403);
    expect((await api.call('POST', `/dialer/sessions/${session.id}/skip`, t.admin!)).statusCode).toBe(403);
    expect((await api.call('POST', `/dialer/sessions/${session.id}/stop`, t.admin!)).json().status).toBe('stopped');
  });

  it('is invisible to people outside the counsellor\'s reach', async () => {
    const session = (await start(await newLeads(1))).json();
    for (const who of [t.lc2!, t.admin2!]) {
      expect((await api.call('GET', `/dialer/sessions/${session.id}`, who)).statusCode).toBe(404);
      expect((await api.call('POST', `/dialer/sessions/${session.id}/stop`, who)).statusCode).toBe(404);
      expect((await api.call('GET', '/dialer/sessions', who)).json().map((s: { id: string }) => s.id)).not.toContain(session.id);
    }
    expect((await api.call('GET', '/dialer/sessions', t.sa!)).json().map((s: { id: string }) => s.id)).toContain(session.id);
  });
});
