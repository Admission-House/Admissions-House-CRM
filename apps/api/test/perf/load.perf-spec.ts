/* eslint-disable @typescript-eslint/no-explicit-any */
// A load test against the real application code and a real database.
// Run from apps/api with:  pnpm load-test
// It makes a throwaway company, starts the API in this process, drives it with autocannon, prints a
// table, and removes the company. Numbers depend on the machine; compare runs on the same machine.
import { randomBytes } from 'node:crypto';
import autocannon from 'autocannon';
import pg from 'pg';
import { startApp } from '../helpers/app.js';
import { createFixture, OFFICE_IP, PASSWORD } from '../helpers/fixtures.js';

import { it } from 'vitest';
const DURATION = Number(process.env.LOAD_SECONDS ?? 10);
const CONNECTIONS = Number(process.env.LOAD_CONNECTIONS ?? 20);

it('measures the main endpoints under load', async () => {
  const owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  const fx = await createFixture(owner);
  const app = await startApp({
    LOGIN_IP_MAX_ATTEMPTS: '500',
    LOG_LEVEL: 'silent',
    RECORDING_INTERVAL_SEC: '0',
    SWEEP_INTERVAL_SEC: '0',
    INTAKE_RETRY_INTERVAL_SEC: '0',
    FOLLOWUP_REMINDER_INTERVAL_SEC: '0',
    IMPORT_INTERVAL_SEC: '0',
  });
  await app.listen(0, '127.0.0.1');
  const url = (await app.getUrl()).replace('[::1]', '127.0.0.1');

  try {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { tenant: fx.slug, email: fx.user('super').email, password: PASSWORD },
      remoteAddress: OFFICE_IP,
    });
    const token = login.json().accessToken as string;
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const read = { authorization: `Bearer ${token}` };
    const source = fx.sourceId('Website');
    let seq = 0;
    const phone = () => `9${String(10_000_000 + ++seq).padStart(9, '0')}`;

    type Scenario = { name: string; connections?: number; amount?: number; opts: Record<string, any> };
    const scenarios: Scenario[] = [
      {
        name: 'POST /leads (write)',
        opts: {
          method: 'POST',
          path: '/api/v1/leads',
          headers: auth,
          setupClient: (c: any) =>
            c.setBody(JSON.stringify({ name: 'Load Lead', phone: phone(), sourceId: source })),
          requests: [
            {
              method: 'POST',
              path: '/api/v1/leads',
              headers: auth,
              setupRequest: (req: any) => ({
                ...req,
                body: JSON.stringify({ name: 'Load Lead', phone: phone(), sourceId: source }),
              }),
            },
          ],
        } as never,
      },
      {
        name: 'POST /intake/leads (api key)',
        opts: {
          requests: [
            {
              method: 'POST',
              path: '/api/v1/intake/leads',
              headers: {
                authorization: `Bearer ${fx.keys.website}`,
                'content-type': 'application/json',
              },
              setupRequest: (req: any) => ({
                ...req,
                body: JSON.stringify({ name: 'Intake Lead', phone: phone() }),
              }),
            },
          ],
        } as never,
      },
      { name: 'GET /leads?limit=50', opts: { path: '/api/v1/leads?limit=50', headers: read } },
      {
        name: 'GET /leads?q=Load (search)',
        opts: { path: '/api/v1/leads?q=Load&limit=50', headers: read },
      },
      { name: 'GET /leads/queues', opts: { path: '/api/v1/leads/queues', headers: read } },
      { name: 'GET /dashboard', opts: { path: '/api/v1/dashboard', headers: read } },
      {
        name: 'GET /reports/leads?groupBy=source',
        opts: { path: '/api/v1/reports/leads?groupBy=source', headers: read },
      },
      {
        name: 'GET /reports/productivity',
        opts: { path: '/api/v1/reports/productivity', headers: read },
      },
      {
        name: 'POST /auth/login (argon2, 4 conns)',
        connections: 4,
        amount: 300,
        opts: {
          method: 'POST',
          path: '/api/v1/auth/login',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            tenant: fx.slug,
            email: fx.user('super').email,
            password: PASSWORD,
          }),
        },
      },
    ];

    const rows: Record<string, string | number>[] = [];
    for (const s of scenarios) {
      const result = await autocannon({
        ...(s.opts as object),
        url: s.opts.path ? url + s.opts.path : url,
        connections: s.connections ?? CONNECTIONS,
        ...(s.amount ? { amount: s.amount } : { duration: DURATION }),
      });
      if (result.non2xx > 0) process.stdout.write(`${s.name}: ${JSON.stringify(result.statusCodeStats)}
`);
      const probe = await app.inject({ method: 'GET', url: '/api/v1/leads?limit=1', headers: read });
    if (probe.statusCode !== 200) process.stdout.write(`probe after "${s.name}": ${probe.statusCode} ${probe.body.slice(0, 200)}
`);
    rows.push({
        scenario: s.name,
        'req/s': Math.round(result.requests.average),
        'p50 ms': result.latency.p50,
        'p97.5 ms': result.latency.p97_5,
        'p99 ms': result.latency.p99,
        'max ms': result.latency.max,
        ok: result['2xx'],
        errors: result.non2xx + result.errors + result.timeouts,
      });
    }
    const leads = (
      await owner.query(`SELECT count(*) FROM leads WHERE tenant_id = $1`, [fx.tenantId])
    ).rows[0].count;
    console.table(rows);
    console.log(
      `${CONNECTIONS} connections, ${DURATION}s each, ${leads} leads in the test company at the end. Run id ${randomBytes(3).toString('hex')}.`,
    );
  } finally {
    await app.close();
    await fx.cleanup();
    await owner.end();
  }
}, 600_000);
