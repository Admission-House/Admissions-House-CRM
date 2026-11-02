import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { startApp } from './helpers/app.js';
import { Client, makeClient } from './helpers/client.js';
import { createFixture, Fixture } from './helpers/fixtures.js';

let app: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;
let api: Client;
let key: string;
let sa: string;

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  app = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500' });
  api = makeClient(app, fx);
  sa = await api.signIn('super');
  await owner.query(`INSERT INTO lead_statuses (tenant_id, name, queue, is_open, sort_order) VALUES ($1, 'Missed Call', 'missed', true, 90)`, [fx.tenantId]);
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.end();
});

const config = { accountSid: 'acme', apiKey: 'key123', apiToken: 'token123', callerId: '08012345678', callbackUrl: 'https://crm.example.com/api/v1/telephony/hooks/exotel/x' };

describe('Exotel connection', () => {
  it('refuses incomplete settings, then saves complete ones without showing them', async () => {
    const bad = await api.call('PUT', '/telephony/connection', sa, { provider: 'exotel', config: { accountSid: 'acme' } });
    expect(bad.statusCode).toBe(422);
    const saved = await api.call('PUT', '/telephony/connection', sa, { provider: 'exotel', config });
    expect(saved.statusCode, saved.body).toBe(200);
    key = saved.json().webhookKey;
    expect(JSON.stringify(saved.json())).not.toContain('token123');
  });

  it('takes a missed incoming call from the address-keyed GET and makes a lead', async () => {
    const url = `/api/v1/telephony/hooks/exotel/${key}?CallSid=in-1&CallFrom=09811122233&CallTo=08012345678&Direction=incoming&CallType=incomplete&CurrentTime=2026-10-28T10:00:00%2B05:30`;
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode, res.body).toBe(200);
    const lead = (await owner.query(`SELECT s.name AS status FROM leads l JOIN lead_statuses s ON s.id = l.status_id WHERE l.tenant_id = $1 AND l.primary_phone = '919811122233'`, [fx.tenantId])).rows[0];
    expect(lead?.status).toBe('Missed Call');
    // The same report again changes nothing.
    expect((await app.inject({ method: 'GET', url })).json()).toMatchObject({ received: 1, repeated: 1 });
  });

  it('takes a JSON status callback by POST', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/telephony/hooks/exotel/${key}`,
      payload: { CallSid: 'out-1', Status: 'no-answer', EventType: 'terminal', From: '09876543210', To: '09811122244', EndTime: '2026-10-28 10:05:00', Direction: 'outbound-api' },
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('refuses a wrong key and a wrong provider name', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/telephony/hooks/exotel/ahw_wrongwrongwrongwrongwrong?CallSid=a&CallFrom=09811122233' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/api/v1/telephony/hooks/generic/${key}?CallSid=a&CallFrom=09811122233` })).statusCode).toBe(401);
  });
});
