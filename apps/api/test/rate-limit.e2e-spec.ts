import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { startApp } from './helpers/app.js';
import { Client, makeClient } from './helpers/client.js';
import { createFixture, Fixture } from './helpers/fixtures.js';

let app: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;
let api: Client;
const t: Record<string, string> = {};

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  // Small allowances so the limits can be reached in a test.
  app = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500', USER_RATE_PER_MIN: '30', HEAVY_RATE_PER_MIN: '3' });
  api = makeClient(app, fx);
  t.sa = await api.signIn('super');
  t.sa2 = await api.signIn('lockme');
  t.admin = await api.signIn('admin', { office: true });
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.end();
});

describe('answers from the API are never cached', () => {
  it('a signed-in answer carries Cache-Control: private, no-store', async () => {
    const res = await api.call('GET', '/leads?limit=5', t.sa!);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('an error answer is not cached either', async () => {
    const res = await api.call('GET', '/leads?limit=5', 'not.a.token');
    expect(res.statusCode).toBe(401);
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('an endpoint that sets its own caching keeps it (the company logo)', async () => {
    const res = await api.call('GET', '/company', t.sa!);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBeDefined();
  });
});

describe('limits for a signed-in user', () => {
  it('stops exports after the heavy allowance, with a retry time, and only for that user', async () => {
    const codes: number[] = [];
    let last = await api.call('GET', '/leads/export?format=csv', t.sa!);
    codes.push(last.statusCode);
    for (let i = 0; i < 3; i++) {
      last = await api.call('GET', '/leads/export?format=csv', t.sa!);
      codes.push(last.statusCode);
    }
    expect(codes).toEqual([200, 200, 200, 429]);
    expect(last.json().error.code).toBe('RATE_LIMITED');
    expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);

    // Another person is not affected by it.
    const other = await api.call('GET', '/leads/export?format=csv', t.admin!);
    expect(other.statusCode).toBe(200);
  });

  it('ordinary requests have their own, larger allowance', async () => {
    let limited = 0;
    let ok = 0;
    for (let i = 0; i < 40; i++) {
      const res = await api.call('GET', '/auth/me', t.sa2!);
      if (res.statusCode === 429) limited++;
      else if (res.statusCode === 200) ok++;
    }
    expect(ok).toBe(30);
    expect(limited).toBe(10);
  });
});
