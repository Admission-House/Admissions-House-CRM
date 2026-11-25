import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { startApp } from './helpers/app.js';
import { Client, makeClient } from './helpers/client.js';
import { createFixture, Fixture, OFFICE, OUTSIDE_IP, PASSWORD } from './helpers/fixtures.js';

let app: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;
let api: Client;
const t: Record<string, string> = {};

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  app = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500' });
  api = makeClient(app, fx);
  t.sa = await api.signIn('super');
  t.admin = await api.signIn('admin', { office: true });
  t.admin2 = await api.signIn('admin2', { office: true });
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.end();
});

type Body = Record<string, unknown>;
/** About 5.5 km north of the office. */
const away = { lat: OFFICE.lat + 0.05, lng: OFFICE.lng, accuracy: 20 };
const login = (name: string, extra: Body = {}) =>
  app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { tenant: fx.slug, email: fx.user(name).email, password: PASSWORD, clientType: 'web', ...extra }, remoteAddress: OUTSIDE_IP });
const status = (requestId: string, token: string) =>
  app.inject({ method: 'POST', url: '/api/v1/auth/remote-signin/status', payload: { tenant: fx.slug, requestId, token }, remoteAddress: OUTSIDE_IP });
const decide = (token: string, id: string, what: 'approve' | 'reject') => api.call('POST', `/remote-signins/${id}/${what}`, token);
const ask = async (name: string, extra: Body = {}) => {
  const res = await login(name, { location: away, remoteReason: 'College visit in Noida', ...extra });
  expect(res.statusCode, res.body).toBe(403);
  expect(res.json().error.code).toBe('REMOTE_APPROVAL_PENDING');
  return res.json().error.details as { requestId: string; pollToken: string; expiresAt: string };
};
const requestNotes = async (requestId: string) =>
  (await owner.query(`SELECT user_id FROM notifications WHERE payload->>'event' = 'remote_signin_request' AND payload->>'requestId' = $1`, [requestId])).rows.map((r) => r.user_id as string);

describe('signing in from outside the office with approval', () => {
  it('offers approval once the password is right, and only then', async () => {
    const outside = await login('lc1', { location: away });
    expect(outside.statusCode).toBe(403);
    expect(outside.json().error).toMatchObject({ code: 'OUTSIDE_OFFICE', details: { canRequestApproval: true } });
    const wrong = await login('lc1', { password: 'not-the-password', location: away, remoteReason: 'Home' });
    expect(wrong.json().error.code).toBe('INVALID_CREDENTIALS');
    const mobile = await login('lc1', { clientType: 'mobile', location: away });
    expect(mobile.json().error.details?.canRequestApproval).toBeUndefined();
    expect((await owner.query(`SELECT count(*)::int AS n FROM remote_signin_requests WHERE user_id = $1`, [fx.user('lc1').id])).rows[0].n).toBe(0);
  });

  it('sends one request to the Super Admins and the team Admin, with the reason and the distance', async () => {
    const r = await ask('lc1');
    const again = await ask('lc1', { remoteReason: 'College visit, will be back at 3' });
    expect(again.requestId).toBe(r.requestId); // pressing twice does not ask twice
    const told = await requestNotes(r.requestId);
    expect(told).toContain(fx.user('admin').id); // the team Admin
    expect(told).toContain(fx.user('super').id); // and the Super Admins
    expect(told).not.toContain(fx.user('admin2').id); // not another team's Admin
    expect(told).not.toContain(fx.user('lc1').id);
    expect(told.length).toBe(new Set(told).size);
    const row = (await owner.query(`SELECT * FROM remote_signin_requests WHERE id = $1`, [r.requestId])).rows[0];
    expect(row).toMatchObject({ state: 'pending', reason: 'College visit, will be back at 3' });
    expect(row.distance_m).toBeGreaterThan(5000);
    expect(row.distance_m).toBeLessThan(6000);
    // Only the newest browser token answers.
    expect((await status(r.requestId, r.pollToken)).statusCode).toBe(404);
    expect((await status(again.requestId, again.pollToken)).json()).toEqual({ state: 'pending', decidedBy: null });
    expect((await status(again.requestId, 'x'.repeat(32))).statusCode).toBe(404);
  });

  it('is answered only by Super Admins and the person\'s own Admin', async () => {
    const { requestId } = (await owner.query(`SELECT id AS "requestId" FROM remote_signin_requests WHERE user_id = $1 AND state = 'pending'`, [fx.user('lc1').id])).rows[0];
    const lc2 = await api.signIn('lc2', { office: true });
    expect((await decide(lc2, requestId, 'approve')).statusCode).toBe(403);
    expect((await decide(t.admin2!, requestId, 'approve')).statusCode).toBe(404);
    expect(((await api.call('GET', '/remote-signins', t.admin2!)).json() as { id: string }[]).map((x) => x.id)).not.toContain(requestId);
    expect(((await api.call('GET', '/remote-signins', t.admin!)).json() as { id: string }[]).map((x) => x.id)).toContain(requestId);
  });

  it('once approved, signs the person in for the rest of the day and marks them present, saying how', async () => {
    const { requestId, pollToken } = await ask('lc1');
    const ok = await decide(t.admin!, requestId, 'approve');
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ state: 'approved', decidedBy: 'admin', user: { name: 'lc1' } });
    expect((await status(requestId, pollToken)).json()).toEqual({ state: 'approved', decidedBy: 'admin' });
    expect((await decide(t.sa!, requestId, 'reject')).json().error.code).toBe('REQUEST_DECIDED');

    // Signing in now works from outside the office, even without a position, and again later the same day.
    const first = await login('lc1');
    expect(first.statusCode, first.body).toBe(200);
    expect((await login('lc1', { location: away })).statusCode).toBe(200);
    const day = (await owner.query(`SELECT method FROM attendance_records WHERE user_id = $1 ORDER BY work_date DESC LIMIT 1`, [fx.user('lc1').id])).rows[0];
    expect(day.method).toBe('remote_approved');
    expect((await owner.query(`SELECT used_at FROM remote_signin_requests WHERE id = $1`, [requestId])).rows[0].used_at).not.toBeNull();
    expect((await owner.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'remote_signin.approve' AND entity_id = $1`, [fx.user('lc1').id])).rows[0].n).toBe(1);
    expect((await owner.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'auth.remote_signin' AND entity_id = $1`, [fx.user('lc1').id])).rows[0].n).toBe(2);
    // The approval is for that day only.
    await owner.query(`UPDATE remote_signin_requests SET work_date = work_date - 1 WHERE id = $1`, [requestId]);
    expect((await login('lc1', { location: away })).json().error.code).toBe('OUTSIDE_OFFICE');
  });

  it('a rejected request keeps the person out, and they may ask again', async () => {
    const { requestId, pollToken } = await ask('lc2');
    expect((await decide(t.sa!, requestId, 'reject')).json()).toMatchObject({ state: 'rejected' });
    expect((await status(requestId, pollToken)).json()).toMatchObject({ state: 'rejected' });
    expect((await login('lc2', { location: away })).json().error).toMatchObject({ code: 'OUTSIDE_OFFICE', details: { canRequestApproval: true } });
    const next = await ask('lc2');
    expect(next.requestId).not.toBe(requestId);
  });

  it('expires when nobody answers in time', async () => {
    const { requestId, pollToken } = await ask('lc3');
    await owner.query(`UPDATE remote_signin_requests SET expires_at = now() - interval '1 second' WHERE id = $1`, [requestId]);
    expect((await decide(t.admin!, requestId, 'approve')).json().error.code).toBe('REQUEST_EXPIRED');
    expect((await status(requestId, pollToken)).json()).toMatchObject({ state: 'expired' });
    expect((await login('lc3', { location: away })).json().error.code).toBe('OUTSIDE_OFFICE');
  });

  it('waits for the position before asking, unless the browser cannot give one', async () => {
    const noPosition = await login('in1', { remoteReason: 'Working from home today' });
    expect(noPosition.json().error.code).toBe('OUTSIDE_OFFICE');
    const r = await (async () => {
      const res = await login('in1', { remoteReason: 'Working from home today', locationUnavailable: true });
      expect(res.json().error.code).toBe('REMOTE_APPROVAL_PENDING');
      return res.json().error.details as { requestId: string };
    })();
    const row = (await owner.query(`SELECT office_reason, distance_m, lat FROM remote_signin_requests WHERE id = $1`, [r.requestId])).rows[0];
    expect(row).toMatchObject({ distance_m: null, lat: null });
  });

  it('a person who does not have to be at the office never needs it', async () => {
    expect((await login('super', { location: away })).statusCode).toBe(200);
  });
});
