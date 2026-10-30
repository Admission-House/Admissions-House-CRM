import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { startApp } from './helpers/app.js';
import { Client, makeClient } from './helpers/client.js';
import { createFixture, Fixture } from './helpers/fixtures.js';

let app: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;
let api: Client;
let webhookKey: string;
const t: Record<string, string> = {};

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  app = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500' });
  api = makeClient(app, fx);
  t.sa = await api.signIn('super');
  for (const name of ['admin', 'lc1', 'lc2']) t[name] = await api.signIn(name, { office: true });

  // The status a missed call moves a lead to.
  await owner.query(`INSERT INTO lead_statuses (tenant_id, name, queue, is_open, sort_order) VALUES ($1, 'Missed Call', 'missed', true, 90)`, [fx.tenantId]);
  // Counsellors' own numbers, so the provider can say who took a call.
  await owner.query(`UPDATE users SET phone = '9810000001' WHERE id = $1`, [fx.user('lc1').id]);
  await owner.query(`UPDATE users SET phone = '9810000002' WHERE id = $1`, [fx.user('lc2').id]);

  const saved = await api.call('PUT', '/telephony/connection', t.sa!, { provider: 'generic', config: { simulate: true }, recordingHosts: ['recordings.example.com'] });
  expect(saved.statusCode, saved.body).toBe(200);
  webhookKey = saved.json().webhookKey;
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.end();
});

// ------------------------------------------------------------------ helpers

let counter = 0;
const phone = () => `9${String(800_000_000 + ++counter).padStart(9, '0')}`;
const callId = () => `call-${Date.now()}-${++counter}`;
const errorCode = (res: { json: () => { error?: { code?: string } } }) => res.json().error?.code;
const at = (offsetSec: number) => new Date(Date.UTC(2026, 9, 28, 10, 0, 0) + offsetSec * 1000).toISOString();

function hook(body: unknown, key: string | null = webhookKey, header: 'authorization' | 'x-webhook-key' = 'authorization') {
  const headers: Record<string, string> = {};
  if (key) headers[header] = header === 'authorization' ? `Bearer ${key}` : key;
  return app.inject({ method: 'POST', url: '/api/v1/telephony/webhook', payload: body as never, headers });
}
const ev = (id: string, event: string, customer: string, offset: number, extra: Record<string, unknown> = {}) => ({
  providerCallId: id, event, direction: 'incoming', customerNumber: customer, at: at(offset), ...extra,
});
const callRow = async (id: string) => (await owner.query(`SELECT * FROM calls WHERE tenant_id = $1 AND provider_call_id = $2`, [fx.tenantId, id])).rows[0];
const leadFor = async (p: string) => (await owner.query(`SELECT l.*, s.name AS status FROM leads l JOIN lead_statuses s ON s.id = l.status_id WHERE l.tenant_id = $1 AND l.primary_phone = $2 AND l.deleted_at IS NULL`, [fx.tenantId, `91${p}`])).rows[0];
const newLead = async (token: string, name: string, p = phone()) => {
  const res = await api.call('POST', '/leads', token, { name, phone: p, sourceId: fx.sourceId('Website') });
  expect(res.statusCode, res.body).toBe(201);
  return { ...res.json(), phone: p };
};

// ================================================================ connection

describe('the telephony connection', () => {
  it('is set up once, shows the webhook key a single time, and never shows credentials', async () => {
    expect(webhookKey).toMatch(/^ahw_[\w-]{40,}$/);
    const got = await api.call('GET', '/telephony/connection', t.sa!);
    expect(got.json()).toMatchObject({ provider: 'generic', isEnabled: true, hasCredentials: true, recordingHosts: ['recordings.example.com'], providers: ['generic'] });
    expect(got.json().webhookKeyPrefix).toBe(webhookKey.slice(0, 8));
    expect(got.body).not.toContain(webhookKey);
    expect(got.body).not.toContain('simulate');

    const stored = (await owner.query(`SELECT config_enc, webhook_key_hash FROM telephony_connections WHERE tenant_id = $1`, [fx.tenantId])).rows[0];
    expect(stored.config_enc).toMatch(/^v1\./);
    expect(stored.config_enc).not.toContain('simulate');
    expect(stored.webhook_key_hash).not.toContain(webhookKey);
  });

  it('keeps the credentials when only other settings change, and returns no new key', async () => {
    const res = await api.call('PUT', '/telephony/connection', t.sa!, { provider: 'generic', recordingHosts: ['recordings.example.com', 'cdn.example.com'] });
    expect(res.statusCode).toBe(200);
    expect(res.json().webhookKey).toBeUndefined();
    expect(res.json().connection).toMatchObject({ hasCredentials: true, recordingHosts: ['recordings.example.com', 'cdn.example.com'] });
    expect((await hook(ev(callId(), 'ringing', phone(), 0))).statusCode).toBe(200);
  });

  it('rejects an unknown provider, bad hosts, and people without the permission', async () => {
    expect(errorCode(await api.call('PUT', '/telephony/connection', t.sa!, { provider: 'nosuch' }))).toBe('PROVIDER_UNKNOWN');
    expect(errorCode(await api.call('PUT', '/telephony/connection', t.sa!, { provider: 'generic', recordingHosts: ['http://evil.example/x'] }))).toBe('VALIDATION_FAILED');
    expect((await api.call('GET', '/telephony/connection', t.admin!)).statusCode).toBe(403);
    expect((await api.call('PUT', '/telephony/connection', t.lc1!, { provider: 'generic' })).statusCode).toBe(403);
    expect((await api.call('POST', '/telephony/connection/rotate-key', t.admin!)).statusCode).toBe(403);
  });

  it('records changes in the audit log without the secrets', async () => {
    const rows = (await owner.query(`SELECT action, after FROM audit_logs WHERE tenant_id = $1 AND entity = 'telephony_connection' ORDER BY id`, [fx.tenantId])).rows;
    expect(rows.map((r) => r.action)).toContain('telephony.create');
    expect(JSON.stringify(rows)).not.toContain('simulate');
    expect(JSON.stringify(rows)).not.toContain(webhookKey);
  });
});

// =================================================================== webhook

describe('receiving call events', () => {
  it('lets the provider in only with the right key', async () => {
    const body = ev(callId(), 'ringing', phone(), 0);
    expect(errorCode(await hook(body, null))).toBe('INVALID_WEBHOOK_KEY');
    expect(errorCode(await hook(body, 'ahw_' + 'x'.repeat(43)))).toBe('INVALID_WEBHOOK_KEY');
    expect(errorCode(await hook(body, 'not-a-key'))).toBe('INVALID_WEBHOOK_KEY');
    expect((await hook(body, webhookKey, 'x-webhook-key')).statusCode).toBe(200);
    // an intake key is not a webhook key
    expect(errorCode(await hook(body, fx.keys.website))).toBe('INVALID_WEBHOOK_KEY');
  });

  it('refuses a body it cannot understand, saying why', async () => {
    const bad = await hook({ providerCallId: 'x', event: 'exploded', direction: 'incoming', customerNumber: '123', at: 'yesterday' });
    expect(bad.statusCode).toBe(422);
    expect(errorCode(bad)).toBe('INVALID_EVENT');
    expect(bad.json().error.message).toContain('event');
    expect((await hook('plain text')).statusCode).toBe(415); // not JSON at all
    expect(errorCode(await hook({ events: [] }))).toBe('INVALID_EVENT');
  });

  it('follows an answered incoming call from a known lead through to the end', async () => {
    const lead = await newLead(t.lc1!, 'Known Caller');
    const id = callId();
    await hook(ev(id, 'ringing', lead.phone, 0, { agentNumber: '9810000001' }));
    expect((await callRow(id)).outcome).toBe('ringing');
    await hook(ev(id, 'answered', lead.phone, 5));
    expect((await callRow(id)).outcome).toBe('connected');
    const done = await hook(ev(id, 'ended', lead.phone, 125, { durationSec: 120 }));
    expect(done.json()).toEqual({ received: 1, repeated: 0 });

    const row = await callRow(id);
    expect(row).toMatchObject({ outcome: 'connected', duration_sec: 120, lead_id: lead.id, user_id: fx.user('lc1').id, direction: 'incoming', counterparty: `91${lead.phone}` });
    expect(row.answered_at.toISOString()).toBe(at(5));
    expect(row.ended_at.toISOString()).toBe(at(125));

    const trail = (await api.call('GET', `/leads/${lead.id}/activities?limit=50`, t.lc1!)).json().items.filter((a: { type: string }) => a.type === 'call');
    expect(trail).toHaveLength(1);
    expect(trail[0].remark).toBe('Incoming call connected, 2 min 0 s');
  });

  it('applies a repeated delivery only once', async () => {
    const lead = await newLead(t.lc1!, 'Repeat Delivery');
    const id = callId();
    const events = [ev(id, 'ringing', lead.phone, 0), ev(id, 'answered', lead.phone, 3), ev(id, 'ended', lead.phone, 63, { durationSec: 60 })];
    expect((await hook({ events })).json()).toEqual({ received: 3, repeated: 0 });
    expect((await hook({ events })).json()).toEqual({ received: 3, repeated: 3 });
    expect(Number((await owner.query(`SELECT count(*) FROM calls WHERE tenant_id = $1 AND provider_call_id = $2`, [fx.tenantId, id])).rows[0].count)).toBe(1);
    const logged = (await api.call('GET', `/leads/${lead.id}/activities?limit=50`, t.lc1!)).json().items.filter((a: { type: string }) => a.type === 'call');
    expect(logged).toHaveLength(1);
    expect(Number((await owner.query(`SELECT count(*) FROM inbound_events WHERE tenant_id = $1 AND provider = 'telephony'`, [fx.tenantId])).rows[0].count)).toBeGreaterThanOrEqual(3);
  });

  it('copes with events arriving out of order, and never loses a connected call', async () => {
    const lead = await newLead(t.lc1!, 'Out Of Order');
    const id = callId();
    await hook(ev(id, 'ended', lead.phone, 90, { durationSec: 80 })); // the end arrives first
    expect((await callRow(id))).toMatchObject({ outcome: 'connected', duration_sec: 80 });
    await hook(ev(id, 'ringing', lead.phone, 0)); // a late "ringing" changes nothing
    await hook(ev(id, 'answered', lead.phone, 10));
    await hook(ev(id, 'missed', lead.phone, 95)); // and a stray "missed" cannot undo it
    expect(await callRow(id)).toMatchObject({ outcome: 'connected', duration_sec: 80 });
  });

  it('keeps the log consistent when the provider clock is slightly behind', async () => {
    const lead = await newLead(t.lc1!, 'Clock Skew');
    const id = callId();
    await hook(ev(id, 'ringing', lead.phone, 10));
    const res = await hook(ev(id, 'ended', lead.phone, 8, { outcome: 'not_picked' }));
    expect(res.statusCode).toBe(200);
    const row = await callRow(id);
    expect(row.ended_at.getTime()).toBeGreaterThanOrEqual(row.started_at.getTime());
  });

  it('records calls placed from the phone itself and the reason an unanswered one failed', async () => {
    const lead = await newLead(t.lc2!, 'Phone Placed');
    const id = callId();
    await hook(ev(id, 'ringing', lead.phone, 0, { direction: 'outgoing', agentNumber: '+91 98100 00002' }));
    await hook(ev(id, 'ended', lead.phone, 30, { direction: 'outgoing', outcome: 'busy' }));
    expect(await callRow(id)).toMatchObject({ direction: 'outgoing', outcome: 'busy', user_id: fx.user('lc2').id, lead_id: lead.id, duration_sec: 0 });
    const trail = (await api.call('GET', `/leads/${lead.id}/activities?limit=50`, t.lc2!)).json().items.find((a: { type: string }) => a.type === 'call');
    expect(trail.remark).toBe('Outgoing call busy');
  });
});

// ===================================================================== missed

describe('a missed call', () => {
  it('moves a known lead to the Missed queue and tells whoever has it', async () => {
    const lead = await newLead(t.lc1!, 'Missed Known');
    const id = callId();
    await hook(ev(id, 'ringing', lead.phone, 0));
    await hook(ev(id, 'missed', lead.phone, 25));

    expect(await callRow(id)).toMatchObject({ outcome: 'missed', lead_id: lead.id });
    expect((await leadFor(lead.phone)).status).toBe('Missed Call');
    const trail = (await api.call('GET', `/leads/${lead.id}/activities?limit=50`, t.lc1!)).json().items.map((a: { type: string; remark: string; oldValue?: string; newValue?: string }) => `${a.type}:${a.remark}`);
    expect(trail).toContain('status_change:Missed call');
    expect(trail).toContain(`call:Missed call from 91${lead.phone}`);
    const told = (await owner.query(`SELECT user_id, payload FROM notifications WHERE tenant_id = $1 AND payload->>'event' = 'missed_call' AND payload->>'leadId' = $2`, [fx.tenantId, lead.id])).rows;
    expect(told).toHaveLength(1);
    expect(told[0].user_id).toBe(fx.user('lc1').id);
    const queues = (await api.call('GET', '/leads/queues', t.lc1!)).json();
    expect(queues.queues.missed).toBeGreaterThanOrEqual(1);
  });

  it('does not tell twice if the provider reports the same missed call in two ways', async () => {
    const lead = await newLead(t.lc1!, 'Missed Twice');
    const id = callId();
    await hook(ev(id, 'missed', lead.phone, 0));
    await hook(ev(id, 'ended', lead.phone, 1, { outcome: 'not_picked' }));
    const told = (await owner.query(`SELECT 1 FROM notifications WHERE tenant_id = $1 AND payload->>'event' = 'missed_call' AND payload->>'leadId' = $2`, [fx.tenantId, lead.id])).rows;
    expect(told).toHaveLength(1);
  });

  it('leaves a lead that is already closed where it is', async () => {
    const lead = await newLead(t.lc1!, 'Missed But Closed');
    await owner.query(`UPDATE leads SET status_id = (SELECT id FROM lead_statuses WHERE tenant_id = $1 AND name = 'Not Interested') WHERE id = $2`, [fx.tenantId, lead.id]);
    await hook(ev(callId(), 'missed', lead.phone, 0));
    expect((await leadFor(lead.phone)).status).toBe('Not Interested');
  });

  it('makes a new lead from an unknown number, from a source of its own, and gives it out', async () => {
    const stranger = phone();
    const id = callId();
    await hook(ev(id, 'ringing', stranger, 0));
    await hook(ev(id, 'missed', stranger, 20));

    const lead = await leadFor(stranger);
    expect(lead).toBeDefined();
    expect(lead.name).toBe(`Missed call ${stranger.slice(-4)}`);
    expect((await callRow(id)).lead_id).toBe(lead.id);
    const source = (await owner.query(`SELECT name, channel_type FROM lead_sources WHERE id = $1`, [lead.source_id])).rows[0];
    expect(source).toEqual({ name: 'Incoming Calls', channel_type: 'call' });

    // calling again from the same number updates that lead rather than making another
    await hook(ev(callId(), 'missed', stranger, 100));
    const count = (await owner.query(`SELECT count(*) FROM leads WHERE tenant_id = $1 AND primary_phone = $2`, [fx.tenantId, `91${stranger}`])).rows[0].count;
    expect(Number(count)).toBe(1);
    expect((await leadFor(stranger)).status).toBe('Missed Call');
  });

  it('does not make a lead from an answered call from an unknown number', async () => {
    const stranger = phone();
    const id = callId();
    await hook(ev(id, 'answered', stranger, 0));
    await hook(ev(id, 'ended', stranger, 40, { durationSec: 40 }));
    expect(await leadFor(stranger)).toBeUndefined();
    expect((await callRow(id)).lead_id).toBeNull();
  });
});

// ==================================================================== rotate

describe('changing the webhook key', () => {
  it('makes the old key stop working and the new one start', async () => {
    const res = await api.call('POST', '/telephony/connection/rotate-key', t.sa!);
    expect(res.statusCode).toBe(200);
    const fresh = res.json().webhookKey as string;
    expect(fresh).not.toBe(webhookKey);
    expect(errorCode(await hook(ev(callId(), 'ringing', phone(), 0), webhookKey))).toBe('INVALID_WEBHOOK_KEY');
    expect((await hook(ev(callId(), 'ringing', phone(), 0), fresh)).statusCode).toBe(200);
    webhookKey = fresh;
  });

  it('stops events when the connection is switched off', async () => {
    await api.call('PUT', '/telephony/connection', t.sa!, { provider: 'generic', isEnabled: false });
    expect(errorCode(await hook(ev(callId(), 'ringing', phone(), 0)))).toBe('INVALID_WEBHOOK_KEY');
    await api.call('PUT', '/telephony/connection', t.sa!, { provider: 'generic', isEnabled: true });
    expect((await hook(ev(callId(), 'ringing', phone(), 0))).statusCode).toBe(200);
  });
});
