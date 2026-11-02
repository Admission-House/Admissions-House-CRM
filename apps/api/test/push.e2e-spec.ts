import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { PushDispatchService } from '../src/push/push-dispatch.service.js';
import { PushProvider, PushTransportError, type PushMessage, type PushResult } from '../src/push/push-provider.js';
import { startApp } from './helpers/app.js';
import { Client, makeClient } from './helpers/client.js';
import { createFixture, Fixture } from './helpers/fixtures.js';

/** Records what it is asked to send. `next` decides what the delivery service "answers". */
class FakeProvider extends PushProvider {
  sent: PushMessage[] = [];
  next: 'ok' | 'down' | 'gone' = 'ok';
  send(messages: readonly PushMessage[]): Promise<PushResult[]> {
    if (this.next === 'down') return Promise.reject(new PushTransportError('Push service answered 503', true));
    this.sent.push(...messages);
    return Promise.resolve(messages.map((): PushResult => (this.next === 'gone' ? { status: 'error', dead: true, message: 'gone' } : { status: 'ok' })));
  }
}

let app: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;
let api: Client;
let dispatch: PushDispatchService;
const t: Record<string, string> = {};

const token = (c: string) => `ExponentPushToken[${c.repeat(22)}]`;
const errorCode = (res: { json: () => { error?: { code?: string } } }) => res.json().error?.code;
const register = (who: string, tok: string, platform = 'android') => api.call('POST', '/push-tokens', t[who]!, { token: tok, platform });

const notify = async (who: string, payload: Record<string, unknown>, ageMinutes = 0) =>
  (await owner.query(
    `INSERT INTO notifications (tenant_id, user_id, type, payload, created_at) VALUES ($1, $2, 'lead_new', $3, now() - make_interval(mins => $4)) RETURNING id::text`,
    [fx.tenantId, fx.user(who).id, JSON.stringify(payload), ageMinutes],
  )).rows[0].id as string;
const pushedAt = async (id: string) => (await owner.query(`SELECT pushed_at FROM notifications WHERE id = $1`, [id])).rows[0].pushed_at as Date | null;
const tokensOf = async (who: string) => (await owner.query(`SELECT token FROM push_tokens WHERE user_id = $1 ORDER BY token`, [fx.user(who).id])).rows.map((r) => r.token as string);
const clearAll = async () => {
  await owner.query(`DELETE FROM push_tokens WHERE tenant_id = $1`, [fx.tenantId]);
  await owner.query(`UPDATE notifications SET pushed_at = now() WHERE tenant_id = $1 AND pushed_at IS NULL`, [fx.tenantId]);
};

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  // The background job is off; the tests run it by hand, with a fake delivery service.
  app = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500', PUSH_INTERVAL_SEC: '0', PUSH_PROVIDER: 'off' });
  api = makeClient(app, fx);
  dispatch = app.get(PushDispatchService);
  for (const name of ['lc1', 'lc2', 'admin']) t[name] = await api.signIn(name, { office: true });
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.end();
});

beforeEach(clearAll);

describe('registering a phone', () => {
  it('needs a sign-in and a real push token', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/v1/push-tokens', payload: { token: token('a'), platform: 'android' } })).statusCode).toBe(401);
    expect((await register('lc1', 'not-a-token')).statusCode).toBe(400);
    expect((await register('lc1', token('a'), 'windows')).statusCode).toBe(400);
  });

  it('saves the phone against the person and the sign-in it was registered in, and can be repeated', async () => {
    expect((await register('lc1', token('a'))).statusCode).toBe(200);
    expect((await register('lc1', token('a'))).statusCode).toBe(200);
    const rows = (await owner.query(`SELECT user_id, session_id, platform FROM push_tokens WHERE tenant_id = $1`, [fx.tenantId])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(fx.user('lc1').id);
    const session = (await owner.query(`SELECT user_id, ended_at FROM user_sessions WHERE id = $1`, [rows[0].session_id])).rows[0];
    expect(session).toMatchObject({ user_id: fx.user('lc1').id, ended_at: null });
  });

  it('moves a phone to the next person who signs in on it, so the first person stops getting their alerts', async () => {
    await register('lc1', token('a'));
    await register('lc2', token('a'));
    expect(await tokensOf('lc1')).toEqual([]);
    expect(await tokensOf('lc2')).toEqual([token('a')]);
  });

  it('removes only the signed-in person\'s own phone', async () => {
    await register('lc1', token('a'));
    await register('lc2', token('b'));
    const res = await api.call('POST', '/push-tokens/remove', t.lc2!, { token: token('a') });
    expect(res.json().removed).toBe(0);
    expect(await tokensOf('lc1')).toEqual([token('a')]);
    expect((await api.call('POST', '/push-tokens/remove', t.lc2!, { token: token('b') })).json().removed).toBe(1);
    expect(await tokensOf('lc2')).toEqual([]);
  });

  it('keeps at most ten phones per person, dropping the oldest', async () => {
    for (let i = 0; i < 12; i++) await register('lc1', token(String.fromCharCode(97 + i)));
    expect(await tokensOf('lc1')).toHaveLength(10);
  });
});

describe('sending alerts', () => {
  it('sends a new notification to the person\'s phone once, with the lead to open', async () => {
    await register('lc1', token('a'));
    const id = await notify('lc1', { event: 'lead_assigned', name: 'Riya Sharma', leadId: 'lead-1', source: 'Google Ads' });
    const fake = new FakeProvider();

    const first = await dispatch.runOnce(fake);
    expect(first).toMatchObject({ claimed: 1, alerts: 1, sent: 1 });
    expect(fake.sent).toEqual([{ to: token('a'), title: 'New lead assigned: Riya Sharma', body: 'From Google Ads', data: { notificationId: id, leadId: 'lead-1' } }]);
    expect(await pushedAt(id)).not.toBeNull();

    const second = await dispatch.runOnce(fake);
    expect(second.claimed).toBe(0);
    expect(fake.sent).toHaveLength(1);
  });

  it('sends to every phone of the person, and to nobody else', async () => {
    await register('lc1', token('a'));
    await register('lc1', token('b'));
    await register('lc2', token('c'));
    await notify('lc1', { event: 'missed_call', name: 'Kabir', leadId: 'l9' });
    const fake = new FakeProvider();
    await dispatch.runOnce(fake);
    expect(fake.sent.map((m) => m.to).sort()).toEqual([token('a'), token('b')]);
  });

  it('marks notifications that are not alerts as taken, without sending them', async () => {
    await register('lc1', token('a'));
    const id = await notify('lc1', { event: 'download', userName: 'X', what: 'a file' });
    const fake = new FakeProvider();
    expect(await dispatch.runOnce(fake)).toMatchObject({ claimed: 1, alerts: 0 });
    expect(fake.sent).toHaveLength(0);
    expect(await pushedAt(id)).not.toBeNull();
  });

  it('does not alert for a notification that is already old, such as after the server was down', async () => {
    await register('lc1', token('a'));
    const id = await notify('lc1', { event: 'missed_call', name: 'Old', leadId: 'l1' }, 30);
    const fake = new FakeProvider();
    expect(await dispatch.runOnce(fake)).toMatchObject({ claimed: 1, stale: 1, alerts: 0 });
    expect(fake.sent).toHaveLength(0);
    expect(await pushedAt(id)).not.toBeNull();
  });

  it('stops alerting a phone once its sign-in has ended', async () => {
    await register('lc1', token('a'));
    await owner.query(`UPDATE user_sessions SET ended_at = now(), ended_reason = 'revoked' WHERE user_id = $1 AND ended_at IS NULL`, [fx.user('lc1').id]);
    await notify('lc1', { event: 'missed_call', name: 'Private Lead', leadId: 'l1' });
    const fake = new FakeProvider();
    expect(await dispatch.runOnce(fake)).toMatchObject({ claimed: 1, alerts: 0 });
    expect(fake.sent).toHaveLength(0);
    // Signing in again (a new session) and registering again brings the alerts back.
    t.lc1 = await api.signIn('lc1', { office: true });
    await register('lc1', token('a'));
    await notify('lc1', { event: 'missed_call', name: 'Next Lead', leadId: 'l2' });
    await dispatch.runOnce(fake);
    expect(fake.sent.map((m) => m.title)).toEqual(['Missed call from Next Lead']);
  });

  it('stops alerting a person who has been deactivated', async () => {
    await register('admin', token('z'));
    await owner.query(`UPDATE users SET status = 'inactive' WHERE id = $1`, [fx.user('admin').id]);
    try {
      await notify('admin', { event: 'forced_logout', userName: 'Someone' });
      const fake = new FakeProvider();
      await dispatch.runOnce(fake);
      expect(fake.sent).toHaveLength(0);
    } finally {
      await owner.query(`UPDATE users SET status = 'active' WHERE id = $1`, [fx.user('admin').id]);
    }
  });

  it('puts the notification back when the delivery service is down, and sends it on the next pass', async () => {
    await register('lc1', token('a'));
    const id = await notify('lc1', { event: 'missed_call', name: 'Retry Me', leadId: 'l1' });
    const fake = new FakeProvider();

    fake.next = 'down';
    expect(await dispatch.runOnce(fake)).toMatchObject({ claimed: 1, retried: 1, sent: 0 });
    expect(await pushedAt(id)).toBeNull();

    fake.next = 'ok';
    expect(await dispatch.runOnce(fake)).toMatchObject({ sent: 1 });
    expect(fake.sent.map((m) => m.title)).toEqual(['Missed call from Retry Me']);
    expect(await pushedAt(id)).not.toBeNull();
  });

  it('forgets a phone that says it is gone', async () => {
    await register('lc1', token('a'));
    await register('lc1', token('b'));
    await notify('lc1', { event: 'missed_call', name: 'X', leadId: 'l1' });
    const fake = new FakeProvider();
    fake.next = 'gone';
    expect(await dispatch.runOnce(fake)).toMatchObject({ sent: 0, dropped: 2 });
    expect(await tokensOf('lc1')).toEqual([]);
  });

  it('does not send the same notification twice when two passes run at once', async () => {
    await register('lc1', token('a'));
    for (let i = 0; i < 5; i++) await notify('lc1', { event: 'missed_call', name: `Lead ${i}`, leadId: `l${i}` });
    const fake = new FakeProvider();
    await Promise.all([dispatch.runOnce(fake), dispatch.runOnce(fake), dispatch.runOnce(fake)]);
    expect(fake.sent).toHaveLength(5);
    expect(new Set(fake.sent.map((m) => m.data.notificationId)).size).toBe(5);
  });
});

describe('the test alert', () => {
  it('tells the person when this phone is not set up', async () => {
    const res = await api.call('POST', '/push-tokens/test', t.lc1!);
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('NO_PUSH_PHONE');
  });

  it('reports how many phones got it', async () => {
    await register('lc1', token('a'));
    const res = await api.call('POST', '/push-tokens/test', t.lc1!);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ phones: 1 });
  });
});
