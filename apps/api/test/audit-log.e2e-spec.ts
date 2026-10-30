import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { startApp } from './helpers/app.js';
import { Client, makeClient } from './helpers/client.js';
import { createFixture, Fixture } from './helpers/fixtures.js';

let app: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;
let api: Client;
let sa: string;
let admin: string;

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  app = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500' });
  api = makeClient(app, fx);
  sa = await api.signIn('super');
  admin = await api.signIn('admin', { office: true });
  // Four entries by two different people, over two kinds of action.
  const insert = (actor: string, action: string, entity: string, after: object) =>
    owner.query(`INSERT INTO audit_logs (tenant_id, actor_id, action, entity, after, ip) VALUES ($1, $2, $3, $4, $5, '10.0.0.7')`, [fx.tenantId, fx.user(actor).id, action, entity, JSON.stringify(after)]);
  await insert('super', 'salary.update', 'salary', { basePay: 1000 });
  await insert('super', 'salary.create', 'salary', { basePay: 2000 });
  await insert('admin', 'attendance.exception', 'attendance', { reason: 'network' });
  await insert('admin', 'salaryish.thing', 'other', {});
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.end();
});

const list = (token: string, query = '') => api.call('GET', `/audit-logs${query}`, token);

describe('audit log', () => {
  it('shows entries newest first, with who did it and what changed', async () => {
    const res = await list(sa, '?limit=100');
    expect(res.statusCode, res.body).toBe(200);
    const items = res.json().items as { id: string; action: string; actor: { name: string } | null; after: unknown; ip: string }[];
    expect(items.length).toBeGreaterThanOrEqual(4);
    const ids = items.map((i) => BigInt(i.id));
    expect([...ids].sort((a, b) => (a < b ? 1 : -1))).toEqual(ids); // newest first
    const update = items.find((i) => i.action === 'salary.update')!;
    expect(update).toMatchObject({ actor: { name: 'super' }, after: { basePay: 1000 }, ip: '10.0.0.7' });
  });

  it('filters by person, by action or action group, and by day', async () => {
    const byAdmin = (await list(sa, `?limit=100&actorId=${fx.user('admin').id}`)).json().items as { actor: { name: string } }[];
    expect(byAdmin.length).toBeGreaterThanOrEqual(2);
    expect(byAdmin.every((i) => i.actor.name === 'admin')).toBe(true);

    // "salary" means every salary.* action, and does not catch "salaryish.thing".
    const salary = (await list(sa, '?limit=100&action=salary')).json().items as { action: string }[];
    expect(salary.map((i) => i.action).sort()).toEqual(['salary.create', 'salary.update']);
    expect((await list(sa, '?limit=100&action=salary.update')).json().items).toHaveLength(1);

    const today = (await owner.query(`SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`)).rows[0].d as string;
    expect((await list(sa, `?limit=100&from=${today}&to=${today}`)).json().items.length).toBeGreaterThanOrEqual(4);
    expect((await list(sa, '?limit=100&from=2020-01-01&to=2020-01-02')).json().items).toEqual([]);
    expect((await list(sa, '?from=2026-02-02&to=2026-02-01')).json().error.code).toBe('RANGE_INVALID');
  });

  it('pages through the entries without repeating any', async () => {
    const first = (await list(sa, '?limit=2')).json();
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = (await list(sa, `?limit=2&cursor=${first.nextCursor}`)).json();
    const seen = new Set([...first.items, ...second.items].map((i: { id: string }) => i.id));
    expect(seen.size).toBe(first.items.length + second.items.length);
  });

  it('lists the kinds of action to filter by', async () => {
    const res = await api.call('GET', '/audit-logs/actions', sa);
    expect(res.json()).toEqual(expect.arrayContaining(['salary.update', 'attendance.exception']));
  });

  it('is for the Super Admin only', async () => {
    expect((await list(admin)).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/audit-logs' })).statusCode).toBe(401);
  });
});
