import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { startApp } from './helpers/app.js';

const SECRET = 'cron-secret-for-tests-0123456789abcdef';
let cron: NestFastifyApplication;
let server: NestFastifyApplication;

const call = (app: NestFastifyApplication, group: string, token?: string) =>
  app.inject({
    method: 'GET',
    url: `/api/v1/internal/jobs/${group}`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    remoteAddress: '198.51.100.30',
  });

beforeAll(async () => {
  // A scheduler setup (Vercel): no timers, jobs wait to be called. One job is switched on so there is something to run.
  cron = await startApp({
    JOBS_MODE: 'cron',
    CRON_SECRET: SECRET,
    COMMUNICATION_SWEEP_SEC: '60',
    INTAKE_RETRY_INTERVAL_SEC: '60',
  });
  // An ordinary server: timers do the work, and the scheduler's address is switched off.
  server = await startApp({ CRON_SECRET: SECRET });
});

afterAll(async () => {
  await cron?.close();
  await server?.close();
});

describe('the address a scheduler calls', () => {
  it('refuses a request without the secret, or with another one', async () => {
    expect((await call(cron, 'minute')).statusCode).toBe(401);
    expect((await call(cron, 'minute', 'wrong-secret-wrong-secret-wrong-secret')).statusCode).toBe(
      401,
    );
    expect((await call(cron, 'minute', SECRET.slice(0, -1))).statusCode).toBe(401);
  });

  it('runs the group when the secret is right, and says what each job did', async () => {
    const res = await call(cron, 'minute', SECRET);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.group).toBe('minute');
    const names = (body.results as { name: string; ok: boolean }[]).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['communication-sweep', 'intake-retry']));
    expect((body.results as { ok: boolean }[]).every((r) => r.ok)).toBe(true);
    expect((await call(cron, 'daily', SECRET)).statusCode).toBe(200);
  });

  it('does not know any other group', async () => {
    expect((await call(cron, 'hourly', SECRET)).statusCode).toBe(404);
    expect((await call(cron, '..%2Fusers', SECRET)).statusCode).toBe(404);
  });

  it('does not exist on a server that runs its own timers, even with the right secret', async () => {
    expect((await call(server, 'minute', SECRET)).statusCode).toBe(404);
  });
});
