import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { startApp } from './helpers/app.js';
import { Client, makeClient } from './helpers/client.js';
import { createFixture, Fixture, OFFICE_IP } from './helpers/fixtures.js';

/** Who is told about sign-ins and breaks: the Super Admins, and the Admin of the team; never another team, never the counsellor. */
let app: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;
let api: Client;
const t: Record<string, string> = {};

const eventsFor = async (who: string, event: string, about: string) =>
  (await owner.query(`SELECT payload FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND type = 'security' AND payload->>'event' = $3 AND payload->>'userId' = $4`, [fx.tenantId, fx.user(who).id, event, fx.user(about).id])).rows;

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  // admin2 manages nobody in this company: att1 belongs to the team of `admin`.
  app = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500' });
  api = makeClient(app, fx);
  t.admin = await api.signIn('admin', { office: true });
  t.sa = await api.signIn('super');
  await owner.query(`DELETE FROM notifications WHERE tenant_id = $1`, [fx.tenantId]);
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.end();
});

describe('who hears about a counsellor signing in and taking a long break', () => {
  it('is told to the Super Admin and to the Admin of that team, and to nobody else', async () => {
    t.att1 = await api.signIn('att1', { office: true });
    expect(await eventsFor('super', 'login_ok', 'att1')).toHaveLength(1);
    expect(await eventsFor('admin', 'login_ok', 'att1')).toHaveLength(1);
    expect(await eventsFor('admin2', 'login_ok', 'att1')).toHaveLength(0); // another team's Admin
    expect(await eventsFor('att1', 'login_ok', 'att1')).toHaveLength(0); // the person themself
    expect(await eventsFor('att2', 'login_ok', 'att1')).toHaveLength(0); // a colleague
  });

  it('includes a refused sign-in, with the same people told', async () => {
    const res = await api.login({ ...api.credentials('att2'), location: { lat: 1, lng: 1, accuracy: 10 } }, OFFICE_IP);
    expect(res.statusCode).toBe(403);
    expect(await eventsFor('super', 'login_refused', 'att2')).toHaveLength(1);
    expect(await eventsFor('admin', 'login_refused', 'att2')).toHaveLength(1);
    expect(await eventsFor('admin2', 'login_refused', 'att2')).toHaveLength(0);
  });

  it('says nothing when the location is only being asked for, so the real reason that follows is the one told', async () => {
    const asked = await api.login(api.credentials('att3'), OFFICE_IP);
    expect(asked.statusCode).toBe(403);
    expect(asked.json().error.details.reason).toBe('gps_missing');
    expect(await eventsFor('super', 'login_refused', 'att3')).toHaveLength(0);
    const far = await api.login({ ...api.credentials('att3'), location: { lat: 1, lng: 1, accuracy: 10 } }, OFFICE_IP);
    expect(far.statusCode).toBe(403);
    expect((await eventsFor('super', 'login_refused', 'att3')).map((r) => r.payload.reason)).toEqual(['gps_far']);
  });

  it('says nothing about a break that stays inside its allowance', async () => {
    const lunch = (await owner.query(`SELECT id FROM break_types WHERE tenant_id = $1 AND name = 'Lunch'`, [fx.tenantId])).rows[0].id as string;
    const started = await api.call('POST', '/attendance/breaks/start', t.att1!, { breakTypeId: lunch }, OFFICE_IP);
    expect(started.statusCode, started.body).toBe(200);
    await owner.query(`UPDATE break_logs SET started_at = now() - interval '45 minutes' WHERE id = $1`, [started.json().id]);
    const ended = await api.call('POST', '/attendance/breaks/end', t.att1!, undefined, OFFICE_IP);
    expect(ended.json().overByMinutes).toBe(0);
    expect(await eventsFor('admin', 'break_over', 'att1')).toHaveLength(0);
    // The allowance is used up but the day's hard limit is not, so another break may still be started.
    expect((await api.call('POST', '/attendance/breaks/start', t.att1!, { breakTypeId: lunch }, OFFICE_IP)).statusCode).toBe(200);
  });

  it('tells them when one long break goes over, to the Super Admin and the team Admin only', async () => {
    const lunch = (await owner.query(`SELECT id FROM break_types WHERE tenant_id = $1 AND name = 'Lunch'`, [fx.tenantId])).rows[0].id as string;
    t.att3 = await api.signIn('att3', { office: true });
    const started = await api.call('POST', '/attendance/breaks/start', t.att3!, { breakTypeId: lunch }, OFFICE_IP);
    await owner.query(`UPDATE break_logs SET started_at = now() - interval '70 minutes' WHERE id = $1`, [started.json().id]);
    const ended = await api.call('POST', '/attendance/breaks/end', t.att3!, undefined, OFFICE_IP);
    expect(ended.json().overByMinutes).toBeGreaterThan(0);
    for (const who of ['super', 'admin']) expect(await eventsFor(who, 'break_over', 'att3'), who).toHaveLength(1);
    expect(await eventsFor('admin2', 'break_over', 'att3')).toHaveLength(0);
    expect(await eventsFor('att3', 'break_over', 'att3')).toHaveLength(0);
  });
});
