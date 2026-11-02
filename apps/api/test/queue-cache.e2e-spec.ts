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
let n = 0;
const phone = () => `9${String(500_000_000 + ++n).padStart(9, '0')}`;

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  app = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500', QUEUE_COUNT_CACHE_SEC: '30' });
  api = makeClient(app, fx);
  t.sa = await api.signIn('super');
  t.lc = await api.signIn('counsellor', { office: true });
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.end();
});

const total = async (token: string) => (await api.call('GET', '/leads/queues', token)).json().total as number;

describe('queue counts', () => {
  it('are reused for a few seconds for a Super Admin, but always fresh for a counsellor', async () => {
    const saBefore = await total(t.sa!);
    const lcBefore = await total(t.lc!);

    const made = await api.call('POST', '/leads', t.lc!, { name: 'Cache Lead', phone: phone(), sourceId: fx.sourceId('Website') });
    expect(made.statusCode).toBe(201);

    expect(await total(t.lc!)).toBe(lcBefore + 1); // own scope: never cached
    expect(await total(t.sa!)).toBe(saBefore); // all scope: the earlier count is reused
  });
});
