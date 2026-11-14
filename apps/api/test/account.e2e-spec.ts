import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { startApp } from './helpers/app.js';
import { Client, makeClient } from './helpers/client.js';
import { createFixture, Fixture, OFFICE_IP, PASSWORD } from './helpers/fixtures.js';

let app: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;
let api: Client;
const t: Record<string, string> = {};

const put = (token: string, body: Record<string, unknown>) => api.call('PUT', '/me/account', token, body, OFFICE_IP);
const loginAlerts = async (about: string) =>
  (await owner.query(`SELECT user_id FROM notifications WHERE tenant_id = $1 AND type = 'security' AND payload->>'event' = 'login_ok' AND payload->>'userId' = $2`, [fx.tenantId, fx.user(about).id])).rows.map((r) => r.user_id as string);

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  app = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500' });
  api = makeClient(app, fx);
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.end();
});

describe('a person changing their own name, number and email', () => {
  beforeAll(async () => {
    t.lc = await api.signIn('counsellor', { office: true });
    t.sa = await api.signIn('super');
  });

  it('works for a counsellor and a super admin alike, without a password for name and number', async () => {
    const a = await put(t.lc!, { name: 'Asha Verma', phone: '9876543210' });
    expect(a.statusCode, a.body).toBe(200);
    expect(a.json()).toMatchObject({ name: 'Asha Verma', phone: expect.stringMatching(/9876543210$/) });
    const b = await api.call('PUT', '/me/account', t.sa!, { name: 'Boss Person' });
    expect(b.statusCode, b.body).toBe(200);
    const row = (await owner.query(`SELECT name FROM users WHERE id = $1`, [fx.user('counsellor').id])).rows[0];
    expect(row.name).toBe('Asha Verma');
  });

  it('refuses an empty change and a bad number', async () => {
    expect((await put(t.lc!, {})).statusCode).toBe(400);
    expect((await put(t.lc!, { phone: '12' })).statusCode).toBe(400);
  });

  it('needs the current password to change the email, and never lets it clash with someone else', async () => {
    const fresh = 'asha.new@example.test';
    expect((await put(t.lc!, { email: fresh })).statusCode).toBe(403);
    expect((await put(t.lc!, { email: fresh, currentPassword: 'wrong-password' })).statusCode).toBe(403);
    const taken = await put(t.lc!, { email: fx.user('super').email, currentPassword: PASSWORD });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error.code).toBe('EMAIL_TAKEN');
    const ok = await put(t.lc!, { email: fresh, currentPassword: PASSWORD });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().email).toBe(fresh);
    const audit = await owner.query(`SELECT count(*)::int n FROM audit_logs WHERE tenant_id = $1 AND action = 'user.update_self' AND entity_id = $2`, [fx.tenantId, fx.user('counsellor').id]);
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(2);
  });
});

describe('the sign-in alert to the Super Admins', () => {
  it('tells every Super Admin when a counsellor signs in, but not the same person again within 30 minutes', async () => {
    await api.signIn('counsellor2', { office: true });
    const first = await loginAlerts('counsellor2');
    expect(first.length).toBeGreaterThanOrEqual(1);
    expect(first).toContain(fx.user('super').id);
    expect(first).not.toContain(fx.user('counsellor2').id); // not told about themselves
    await api.signIn('counsellor2', { office: true });
    expect((await loginAlerts('counsellor2')).length).toBe(first.length);
  });
});
