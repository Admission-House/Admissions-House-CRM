import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { DatabaseService } from '../src/database/database.service.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import { startApp } from './helpers/app.js';
import { Client, makeClient } from './helpers/client.js';
import { createFixture, Fixture } from './helpers/fixtures.js';

let app: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;
let api: Client;
const t: Record<string, string> = {};

const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
const dataUrl = (b: Buffer, type = 'image/jpeg') => `data:${type};base64,${b.toString('base64')}`;
const count = async (userId: string, type: string) =>
  Number(
    (
      await owner.query(
        `SELECT count(*) FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND type = $3`,
        [fx.tenantId, userId, type],
      )
    ).rows[0].count,
  );
const send = (userId: string, type: 'lead_new' | 'security' | 'communication') =>
  app
    .get(DatabaseService)
    .withTenant(fx.tenantId, (trx) =>
      app
        .get(NotificationsService)
        .notify(trx, { tenantId: fx.tenantId, userIds: [userId], type, payload: { test: true } }),
    );

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  app = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500' });
  api = makeClient(app, fx);
  t.lc = await api.signIn('counsellor', { office: true });
  t.sa = await api.signIn('super');
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.end();
});

describe('profile photo', () => {
  it('can be set, read back by a colleague, and removed', async () => {
    const set = await api.call('PUT', '/me/avatar', t.lc!, { image: dataUrl(jpeg) });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json()).toMatchObject({ hasAvatar: true });
    const got = await api.call('GET', `/users/${fx.user('counsellor').id}/avatar`, t.sa!);
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/jpeg');
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(got.rawPayload, jpeg)).toBe(0);
    const me = (await api.call('GET', '/auth/me', t.lc!)).json();
    expect(me.user.avatarVersion).toEqual(expect.any(Number));
    const del = await api.call('DELETE', '/me/avatar', t.lc!);
    expect(del.json()).toMatchObject({ hasAvatar: false });
    expect(
      (await api.call('GET', `/users/${fx.user('counsellor').id}/avatar`, t.sa!)).statusCode,
    ).toBe(404);
  });

  it('refuses SVG, a wrong kind of file, an oversized picture and a missing token', async () => {
    const svg = dataUrl(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'),
      'image/svg+xml',
    );
    expect((await api.call('PUT', '/me/avatar', t.lc!, { image: svg })).statusCode).toBe(400);
    expect(
      (
        await api.call('PUT', '/me/avatar', t.lc!, {
          image: dataUrl(Buffer.from('not a picture at all'), 'image/png'),
        })
      ).statusCode,
    ).toBe(400);
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(70_000)]);
    expect((await api.call('PUT', '/me/avatar', t.lc!, { image: dataUrl(big) })).statusCode).toBe(
      400,
    );
    expect((await api.call('PUT', '/me/avatar', '', { image: dataUrl(jpeg) })).statusCode).toBe(
      401,
    );
    expect(
      (await api.call('GET', `/users/${fx.user('counsellor').id}/avatar`, '')).statusCode,
    ).toBe(401);
  });

  it('only changes the signed-in person, never someone else', async () => {
    await api.call('PUT', '/me/avatar', t.sa!, { image: dataUrl(jpeg) });
    expect(
      (await api.call('GET', `/users/${fx.user('counsellor').id}/avatar`, t.sa!)).statusCode,
    ).toBe(404);
    await api.call('DELETE', '/me/avatar', t.sa!);
  });
});

describe('start page', () => {
  it('can be chosen from pages the person may open, shows in /auth/me, and can be cleared', async () => {
    const view = (await api.call('GET', '/me/preferences', t.lc!)).json();
    expect(view.startPages).toContain('leads');
    const ok = await api.call('PUT', '/me/preferences', t.lc!, { startPage: 'leads' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await api.call('GET', '/auth/me', t.lc!)).json().user.startPage).toBe('leads');
    const cleared = await api.call('PUT', '/me/preferences', t.lc!, { startPage: null });
    expect(cleared.json().startPage).toBeNull();
  });

  it('refuses a page the person may not open, and a made-up one', async () => {
    const view = (await api.call('GET', '/me/preferences', t.lc!)).json();
    const missing = ['dashboard', 'leads', 'communications', 'reports', 'attendance'].find(
      (p) => !view.startPages.includes(p),
    );
    if (missing) {
      const r = await api.call('PUT', '/me/preferences', t.lc!, { startPage: missing });
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe('START_PAGE_NOT_ALLOWED');
    }
    expect(
      (await api.call('PUT', '/me/preferences', t.lc!, { startPage: '/admin' })).statusCode,
    ).toBe(400);
    expect(
      (await api.call('PUT', '/me/preferences', t.lc!, { notify: { security: false } })).statusCode,
    ).toBe(400);
  });
});

describe('alert choices', () => {
  it('everything is on until the person switches a kind off, and only that kind stops', async () => {
    const id = fx.user('counsellor').id;
    await send(id, 'lead_new');
    expect(await count(id, 'lead_new')).toBe(1);
    const off = await api.call('PUT', '/me/preferences', t.lc!, { notify: { leads: false } });
    expect(off.json().notify).toEqual({ leads: false, calls: true, approvals: true });
    expect(await send(id, 'lead_new')).toBe(0);
    expect(await count(id, 'lead_new')).toBe(1);
    expect(await send(id, 'communication')).toBe(1);
    const on = await api.call('PUT', '/me/preferences', t.lc!, { notify: { leads: true } });
    expect(on.json().notify.leads).toBe(true);
    expect(await send(id, 'lead_new')).toBe(1);
  });

  it('never stops security alerts, and one person switching off does not affect another', async () => {
    const lc = fx.user('counsellor').id;
    const sa = fx.user('super').id;
    await api.call('PUT', '/me/preferences', t.lc!, {
      notify: { leads: false, calls: false, approvals: false },
    });
    expect(await send(lc, 'security')).toBe(1);
    expect(await send(sa, 'lead_new')).toBe(1);
  });
});
