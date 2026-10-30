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
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.end();
});

let counter = 0;
const phone = () => `9${String(900_000_000 + ++counter).padStart(9, '0')}`;
const errorCode = (res: { json: () => { error?: { code?: string } } }) => res.json().error?.code;
const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();
const newLead = async (token: string, name: string, p = phone()) => {
  const res = await api.call('POST', '/leads', token, { name, phone: p, sourceId: fx.sourceId('Website') });
  expect(res.statusCode, res.body).toBe(201);
  return { ...res.json(), phone: p } as { id: string; phone: string };
};
const statusId = async (name: string) => (await owner.query(`SELECT id FROM lead_statuses WHERE tenant_id = $1 AND name = $2`, [fx.tenantId, name])).rows[0].id as string;
const callRow = async (id: string) => (await owner.query(`SELECT * FROM calls WHERE id = $1`, [id])).rows[0];
const hook = (events: unknown[]) =>
  app.inject({ method: 'POST', url: '/api/v1/telephony/webhook', payload: { events } as never, headers: { authorization: `Bearer ${webhookKey}` } });
const clearBusy = () => owner.query(`UPDATE calls SET outcome = 'failed' WHERE tenant_id = $1 AND outcome IN ('requested', 'ringing')`, [fx.tenantId]);

// ================================================================= placing

describe('placing a call', () => {
  it('needs calling to be set up first', async () => {
    const l = await newLead(t.lc1!, 'Before Setup');
    const res = await api.call('POST', `/leads/${l.id}/call`, t.lc1!, {});
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('TELEPHONY_NOT_CONFIGURED');
  });

  it('works once a connection exists: rings the counsellor, and records the call as requested', async () => {
    const saved = await api.call('PUT', '/telephony/connection', t.sa!, { provider: 'generic', config: { simulate: true } });
    webhookKey = saved.json().webhookKey;

    const l = await newLead(t.lc1!, 'Call Me');
    const res = await api.call('POST', `/leads/${l.id}/call`, t.lc1!, {});
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json()).toMatchObject({ direction: 'outgoing', number: `91${l.phone}`, outcome: 'requested', lead: { id: l.id, name: 'Call Me' }, user: { name: 'lc1' }, wrappedUp: false, recording: 'none' });
    const row = await callRow(res.json().id);
    expect(row.provider_call_id).toMatch(/^sim-/);

    // the provider then reports what happened, using the id it was given
    const hr = await hook([
      { providerCallId: row.provider_call_id, event: 'answered', direction: 'outgoing', customerNumber: l.phone, at: new Date().toISOString() },
      { providerCallId: row.provider_call_id, event: 'ended', direction: 'outgoing', customerNumber: l.phone, at: new Date(Date.now() + 90_000).toISOString(), durationSec: 90 },
    ]);
    expect(hr.statusCode, hr.body).toBe(200);
    expect((await api.call('GET', `/calls/${res.json().id}`, t.lc1!)).json()).toMatchObject({ outcome: 'connected', durationSec: 90 });
    await clearBusy();
  });

  it('refuses while a call is already in progress, and allows another once it is over', async () => {
    await clearBusy();
    const a = await newLead(t.lc1!, 'Busy A');
    const b = await newLead(t.lc1!, 'Busy B');
    expect((await api.call('POST', `/leads/${a.id}/call`, t.lc1!, {})).statusCode).toBe(202);
    const second = await api.call('POST', `/leads/${b.id}/call`, t.lc1!, {});
    expect(second.statusCode).toBe(409);
    expect(errorCode(second)).toBe('CALL_IN_PROGRESS');
    await clearBusy();
    expect((await api.call('POST', `/leads/${b.id}/call`, t.lc1!, {})).statusCode).toBe(202);
    await clearBusy();
  });

  it('forgets a request that was never connected after a couple of minutes', async () => {
    const a = await newLead(t.lc1!, 'Stale A');
    const first = await api.call('POST', `/leads/${a.id}/call`, t.lc1!, {});
    await owner.query(`UPDATE calls SET started_at = started_at - interval '10 minutes' WHERE id = $1`, [first.json().id]);
    expect((await api.call('POST', `/leads/${a.id}/call`, t.lc1!, {})).statusCode).toBe(202);
    await clearBusy();
  });

  it("needs the counsellor's own number", async () => {
    const l = await newLead(t.lc2!, 'No Agent Number');
    const res = await api.call('POST', `/leads/${l.id}/call`, t.lc2!, {});
    expect(res.statusCode).toBe(422);
    expect(errorCode(res)).toBe('NO_AGENT_NUMBER');
    expect(Number((await owner.query(`SELECT count(*) FROM calls WHERE lead_id = $1`, [l.id])).rows[0].count)).toBe(0);
  });

  it("calls only the lead's own numbers", async () => {
    const l = await newLead(t.lc1!, 'Two Numbers');
    const extra = phone();
    await owner.query(`INSERT INTO lead_phones (tenant_id, lead_id, phone, label) VALUES ($1, $2, $3, 'parent')`, [fx.tenantId, l.id, `91${extra}`]).catch(async () => {
      await owner.query(`INSERT INTO lead_phones (tenant_id, lead_id, phone) VALUES ($1, $2, $3)`, [fx.tenantId, l.id, `91${extra}`]);
    });
    const ok = await api.call('POST', `/leads/${l.id}/call`, t.lc1!, { phone: extra });
    expect(ok.statusCode, ok.body).toBe(202);
    expect(ok.json().number).toBe(`91${extra}`);
    await clearBusy();
    const stranger = await api.call('POST', `/leads/${l.id}/call`, t.lc1!, { phone: phone() });
    expect(errorCode(stranger)).toBe('PHONE_NOT_ON_LEAD');
    expect(errorCode(await api.call('POST', `/leads/${l.id}/call`, t.lc1!, { phone: 'abc' }))).toBe('PHONE_INVALID');
  });

  it('is not allowed on a lead the person cannot see, or without the permission', async () => {
    const l = await newLead(t.lc2!, 'Not Yours');
    expect((await api.call('POST', `/leads/${l.id}/call`, t.lc1!, {})).statusCode).toBe(404);
    const readerRole = (await owner.query(`INSERT INTO roles (tenant_id, name, data_scope, requires_office) VALUES ($1, 'Reader', 'all', false) RETURNING id`, [fx.tenantId])).rows[0].id;
    await owner.query(`INSERT INTO role_permissions (tenant_id, role_id, permission_id) SELECT $1, $2, id FROM permissions WHERE code = 'lead.read'`, [fx.tenantId, readerRole]);
    await fx.addUser({ name: 'readonly', roleId: readerRole });
    const token = await api.signIn('readonly');
    expect((await api.call('POST', `/leads/${l.id}/call`, token, {})).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/v1/leads/${l.id}/call` })).statusCode).toBe(401);
  });

  it('reports a provider that cannot dial, and does not leave the person stuck', async () => {
    await api.call('PUT', '/telephony/connection', t.sa!, { provider: 'generic', config: { simulate: false } });
    const l = await newLead(t.lc1!, 'Cannot Dial');
    const res = await api.call('POST', `/leads/${l.id}/call`, t.lc1!, {});
    expect(res.statusCode).toBe(501);
    expect(errorCode(res)).toBe('DIALING_NOT_AVAILABLE');
    const row = (await owner.query(`SELECT outcome, ended_at FROM calls WHERE lead_id = $1`, [l.id])).rows[0];
    expect(row.outcome).toBe('failed');
    expect(row.ended_at).not.toBeNull();
    await api.call('PUT', '/telephony/connection', t.sa!, { provider: 'generic', config: { simulate: true } });
    expect((await api.call('POST', `/leads/${l.id}/call`, t.lc1!, {})).statusCode).toBe(202);
    await clearBusy();
  });
});

// ================================================================ wrapping up

describe('the after-call form', () => {
  const connectedCall = async (name: string) => {
    const l = await newLead(t.lc1!, name);
    const placed = await api.call('POST', `/leads/${l.id}/call`, t.lc1!, {});
    const pid = (await callRow(placed.json().id)).provider_call_id;
    await hook([
      { providerCallId: pid, event: 'answered', direction: 'outgoing', customerNumber: l.phone, at: new Date().toISOString() },
      { providerCallId: pid, event: 'ended', direction: 'outgoing', customerNumber: l.phone, at: new Date(Date.now() + 60_000).toISOString(), durationSec: 60 },
    ]);
    return { lead: l, callId: placed.json().id as string };
  };

  it('sets the status, adds the remark to the history and schedules the follow-up, once', async () => {
    const { lead, callId } = await connectedCall('Wrap Up');
    const unwrapped = (await api.call('GET', '/calls?unwrapped=true', t.lc1!)).json().items.map((c: { id: string }) => c.id);
    expect(unwrapped).toContain(callId);

    const res = await api.call('POST', `/calls/${callId}/wrap-up`, t.lc1!, { statusId: await statusId('Follow-up'), remark: 'Wants fee details', followUp: { dueAt: inAnHour(), note: 'Send brochure' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().call).toMatchObject({ wrappedUp: true, remark: 'Wants fee details' });

    const detail = (await api.call('GET', `/leads/${lead.id}`, t.lc1!)).json();
    expect(detail.status.name).toBe('Follow-up');
    expect(detail.nextFollowupAt).not.toBeNull();
    const trail = (await api.call('GET', `/leads/${lead.id}/activities?limit=50`, t.lc1!)).json().items.map((a: { type: string; remark: string }) => `${a.type}:${a.remark}`);
    expect(trail).toContain('status_change:Wants fee details');
    expect((await api.call('GET', '/calls?unwrapped=true', t.lc1!)).json().items.map((c: { id: string }) => c.id)).not.toContain(callId);

    const again = await api.call('POST', `/calls/${callId}/wrap-up`, t.lc1!, { statusId: await statusId('Contacted') });
    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe('ALREADY_WRAPPED_UP');
  });

  it('leaves the call open if the form is not valid, so it can be sent again', async () => {
    const { lead, callId } = await connectedCall('Wrap Invalid');
    const bad = await api.call('POST', `/calls/${callId}/wrap-up`, t.lc1!, { statusId: await statusId('Follow-up') }); // this status needs a follow-up date
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
    expect((await api.call('GET', `/calls/${callId}`, t.lc1!)).json().wrappedUp).toBe(false);
    expect((await api.call('GET', `/leads/${lead.id}`, t.lc1!)).json().status.name).toBe('New');
    const ok = await api.call('POST', `/calls/${callId}/wrap-up`, t.lc1!, { statusId: await statusId('Contacted'), remark: 'Spoke briefly' });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('is for calls with a lead, and for people who can see the call', async () => {
    const { callId } = await connectedCall('Wrap Access');
    expect((await api.call('POST', `/calls/${callId}/wrap-up`, t.lc2!, { statusId: await statusId('Contacted') })).statusCode).toBe(404);
    const unknown = phone();
    const hookRes = await hook([{ providerCallId: `x-${unknown}`, event: 'answered', direction: 'incoming', customerNumber: unknown, at: new Date().toISOString(), agentNumber: '9810000001' }]);
    expect(hookRes.statusCode).toBe(200);
    const orphan = (await owner.query(`SELECT id FROM calls WHERE provider_call_id = $1`, [`x-${unknown}`])).rows[0].id;
    expect(errorCode(await api.call('POST', `/calls/${orphan}/wrap-up`, t.lc1!, { statusId: await statusId('Contacted') }))).toBe('NO_LEAD');
  });
});

// ==================================================================== history

describe('call history', () => {
  it('lists the calls of a lead, newest first, to whoever may see the lead', async () => {
    const l = await newLead(t.lc1!, 'History');
    for (let i = 0; i < 3; i++) {
      const placed = await api.call('POST', `/leads/${l.id}/call`, t.lc1!, {});
      expect(placed.statusCode).toBe(202);
      await clearBusy();
      await owner.query(`UPDATE calls SET started_at = started_at - make_interval(mins => $2) WHERE id = $1`, [placed.json().id, 10 * (3 - i)]);
    }
    const page1 = await api.call('GET', `/leads/${l.id}/calls?limit=2`, t.lc1!);
    expect(page1.json().items).toHaveLength(2);
    expect(page1.json().nextCursor).not.toBeNull();
    const page2 = await api.call('GET', `/leads/${l.id}/calls?limit=2&cursor=${encodeURIComponent(page1.json().nextCursor)}`, t.lc1!);
    expect(page2.json().items).toHaveLength(1);
    const times = [...page1.json().items, ...page2.json().items].map((c: { startedAt: string }) => Date.parse(c.startedAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect((await api.call('GET', `/leads/${l.id}/calls`, t.admin!)).json().items).toHaveLength(3);
    expect((await api.call('GET', `/leads/${l.id}/calls`, t.lc2!)).statusCode).toBe(404);
  });

  it('filters, and follows the data scope', async () => {
    const mine = (await api.call('GET', '/calls?limit=100', t.lc1!)).json().items as { user: { name: string } | null }[];
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((c) => c.user?.name === 'lc1')).toBe(true);
    expect((await api.call('GET', '/calls', t.lc2!)).json().items).toEqual([]); // sees only their own, and has none
    expect((await api.call('GET', '/calls?limit=100', t.admin!)).json().items.length).toBe(mine.length); // the team lead sees the team
    expect((await api.call('GET', '/calls', t.admin2!)).json().items).toEqual([]);
    expect((await api.call('GET', '/calls?limit=100', t.sa!)).json().items.length).toBeGreaterThanOrEqual(mine.length);

    const connected = (await api.call('GET', '/calls?outcome=connected&limit=100', t.lc1!)).json().items as { outcome: string }[];
    expect(connected.length).toBeGreaterThan(0);
    expect(connected.every((c) => c.outcome === 'connected')).toBe(true);
    const today = new Date().toISOString().slice(0, 10);
    expect((await api.call('GET', `/calls?from=${today}&to=${today}&limit=100`, t.lc1!)).json().items.length).toBeGreaterThan(0);
    expect((await api.call('GET', '/calls?from=2020-01-01&to=2020-01-02', t.lc1!)).json().items).toEqual([]);
    expect(errorCode(await api.call('GET', '/calls?outcome=exploded', t.lc1!))).toBe('VALIDATION_FAILED');
    expect((await api.call('GET', '/calls/0197f000-0000-7000-8000-000000000000', t.lc1!)).statusCode).toBe(404);
  });
});
