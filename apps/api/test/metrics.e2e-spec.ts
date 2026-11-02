import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { startApp } from './helpers/app.js';
import { makeClient } from './helpers/client.js';
import { createFixture, Fixture } from './helpers/fixtures.js';

const TOKEN = 'metrics-test-token-0123456789';

let on: NestFastifyApplication;
let off: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  on = await startApp({ METRICS_TOKEN: TOKEN });
  off = await startApp({});
});

afterAll(async () => {
  await on?.close();
  await off?.close();
  await fx?.cleanup();
  await owner?.end();
});

const scrape = (app: NestFastifyApplication, authorization?: string) =>
  app.inject({ method: 'GET', url: '/api/v1/metrics', headers: authorization ? { authorization } : {} });

describe('the metrics address', () => {
  it('does not exist unless a token is set', async () => {
    expect((await scrape(off)).statusCode).toBe(404);
    expect((await scrape(off, `Bearer ${TOKEN}`)).statusCode).toBe(404);
  });

  it('needs that token, and refuses a missing or wrong one', async () => {
    expect((await scrape(on)).statusCode).toBe(401);
    expect((await scrape(on, 'Bearer wrong-token-wrong-token')).statusCode).toBe(401);
    expect((await scrape(on, `Basic ${TOKEN}`)).statusCode).toBe(401);
    const ok = await scrape(on, `Bearer ${TOKEN}`);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toContain('text/plain');
  });

  it('reports request counts and times, database pool and process numbers', async () => {
    await on.inject({ method: 'GET', url: '/api/v1/health/live' });
    const text = (await scrape(on, `Bearer ${TOKEN}`)).body;
    expect(text).toMatch(/ah_http_requests_total\{method="GET",route="\/api\/v1\/health\/live",status="200"\} \d+/);
    expect(text).toContain('ah_http_request_duration_seconds_bucket{le="0.5",method="GET",route="/api/v1/health/live"}');
    expect(text).toContain('ah_db_pool_connections');
    expect(text).toContain('ah_db_pool_waiting');
    expect(text).toContain('ah_process_cpu_user_seconds_total');
  });

  it('counts by route pattern, so no lead id or other address detail becomes a label', async () => {
    const api = makeClient(on, fx);
    const token = await api.signIn('super');
    const id = '00000000-0000-4000-8000-0000000000ab';
    expect((await api.call('GET', `/leads/${id}`, token)).statusCode).toBe(404);
    expect((await on.inject({ method: 'GET', url: '/api/v1/no/such/place/12345' })).statusCode).toBe(404);

    const text = (await scrape(on, `Bearer ${TOKEN}`)).body;
    expect(text).toMatch(/route="\/api\/v1\/leads\/:id",status="404"/);
    expect(text).toContain('route="unmatched"');
    expect(text).not.toContain(id);
    expect(text).not.toContain('12345');
  });

  it('does not count its own scrapes', async () => {
    await scrape(on, `Bearer ${TOKEN}`);
    const text = (await scrape(on, `Bearer ${TOKEN}`)).body;
    expect(text).not.toContain('route="/api/v1/metrics"');
  });
});
