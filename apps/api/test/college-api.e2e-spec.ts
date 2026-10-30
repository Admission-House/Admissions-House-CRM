import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { startApp } from './helpers/app.js';
import { Client, makeClient } from './helpers/client.js';
import { createFixture, Fixture } from './helpers/fixtures.js';

let app: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;
let api: Client;
let provider: Server;
const t: Record<string, string> = {};
const run = randomUUID().slice(0, 8);
const KEY = `key-${run}`;

// What the pretend provider answers with. The tests change it from case to case.
let reply: { status: number; body: unknown } = { status: 200, body: {} };
let seenKey: string | undefined;

const items = (...rows: Array<{ name: string; course: string; fee: number }>) => ({
  data: { items: rows.map((r) => ({ institute: { name: r.name }, course: r.course, level: 'UG', mode: 'regular', fees: { annual: r.fee } })) },
});

beforeAll(async () => {
  provider = createServer((req, res) => {
    seenKey = req.headers['x-api-key'] as string | undefined;
    const ok = seenKey === KEY;
    res.writeHead(ok ? reply.status : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? reply.body : { error: 'bad key' }));
  });
  await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r));
  const port = (provider.address() as AddressInfo).port;

  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  app = await startApp({
    LOGIN_IP_MAX_ATTEMPTS: '500',
    COLLEGE_API_URL: `http://127.0.0.1:${port}/colleges`,
    COLLEGE_API_KEY: KEY,
    COLLEGE_API_AUTH_HEADER: 'x-api-key',
    COLLEGE_API_AUTH_SCHEME: '',
    COLLEGE_API_ITEMS_PATH: 'data.items',
    COLLEGE_API_FIELD_MAP: JSON.stringify({ college: 'institute.name', annualFee: 'fees.annual' }),
  });
  api = makeClient(app, fx);
  t.sa = await api.signIn('super');
  t.lc1 = await api.signIn('lc1', { office: true });
});

afterAll(async () => {
  await app?.close();
  await new Promise((r) => provider?.close(r));
  await fx?.cleanup();
  await owner?.end();
});

const count = async (table: string) => Number((await owner.query(`SELECT count(*) FROM ${table} WHERE tenant_id = $1`, [fx.tenantId])).rows[0].count);
const errorCode = (res: { json: () => { error?: { code?: string } } }) => res.json().error?.code;

describe('college data provider', () => {
  it('shows how it is connected without ever showing the key', async () => {
    const res = await api.call('GET', '/masters/college-api', t.sa!);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ configured: true, itemsPath: 'data.items', fieldMap: { college: 'institute.name', annualFee: 'fees.annual' } });
    expect(res.json().host).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(res.body).not.toContain(KEY);
  });

  it('is for those who manage master data', async () => {
    expect((await api.call('GET', '/masters/college-api', t.lc1!)).statusCode).toBe(403);
    expect((await api.call('POST', '/masters/college-api/sync', t.lc1!)).statusCode).toBe(403);
  });

  it('previews what it would load without saving, then loads it, then updates it on the next run', async () => {
    reply = { status: 200, body: items({ name: `Orion ${run}`, course: `B.Sc ${run}`, fee: 90000 }, { name: `Orion ${run}`, course: `BBA ${run}`, fee: 80000 }) };
    const before = [await count('colleges'), await count('college_courses')];

    const preview = await api.call('POST', '/masters/college-api/preview', t.sa!);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({ applied: false, rows: 2, colleges: { new: 1 }, offers: { new: 2, updated: 0 }, problems: [] });
    expect(seenKey).toBe(KEY);
    expect([await count('colleges'), await count('college_courses')]).toEqual(before);

    const sync = await api.call('POST', '/masters/college-api/sync', t.sa!);
    expect(sync.statusCode, sync.body).toBe(200);
    expect(sync.json()).toMatchObject({ applied: true, offers: { new: 2 } });
    expect([await count('colleges'), await count('college_courses')]).toEqual([before[0]! + 1, before[1]! + 2]);
    const fee = (await owner.query(`SELECT cc.annual_fee FROM college_courses cc JOIN courses c ON c.id = cc.course_id WHERE cc.tenant_id = $1 AND c.name = $2`, [fx.tenantId, `B.Sc ${run}`])).rows[0];
    expect(Number(fee.annual_fee)).toBe(90000);

    reply = { status: 200, body: items({ name: `Orion ${run}`, course: `B.Sc ${run}`, fee: 95000 }) };
    const again = await api.call('POST', '/masters/college-api/sync', t.sa!);
    expect(again.json()).toMatchObject({ colleges: { existing: 1 }, offers: { new: 0, updated: 1 } });
    const changed = (await owner.query(`SELECT cc.annual_fee FROM college_courses cc JOIN courses c ON c.id = cc.course_id WHERE cc.tenant_id = $1 AND c.name = $2`, [fx.tenantId, `B.Sc ${run}`])).rows[0];
    expect(Number(changed.annual_fee)).toBe(95000);
    const audit = await owner.query(`SELECT 1 FROM audit_logs WHERE tenant_id = $1 AND action = 'master.import' AND after->>'file' = 'college-api'`, [fx.tenantId]);
    expect(audit.rowCount).toBe(2);
  });

  it('reports rows it cannot understand instead of guessing', async () => {
    reply = { status: 200, body: { data: { items: [{ institute: { name: `Bad ${run}` }, course: `X ${run}`, level: 'UG', mode: 'sideways', fees: { annual: 1 } }] } } };
    const res = await api.call('POST', '/masters/college-api/preview', t.sa!);
    expect(res.json().problems[0].problem).toContain('mode');
  });

  it('says what went wrong when the provider answers badly', async () => {
    reply = { status: 500, body: {} };
    expect(errorCode(await api.call('POST', '/masters/college-api/sync', t.sa!))).toBe('COLLEGE_API_FAILED');
    reply = { status: 200, body: { data: 'nothing here' } };
    expect(errorCode(await api.call('POST', '/masters/college-api/sync', t.sa!))).toBe('COLLEGE_API_BAD_RESPONSE');
  });
});
