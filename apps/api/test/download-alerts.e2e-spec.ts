import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { startApp } from './helpers/app.js';
import { Client, makeClient } from './helpers/client.js';
import { createFixture, Fixture, OFFICE_IP } from './helpers/fixtures.js';

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
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.end();
});

/** Download alerts written for a Super Admin, newest first. */
const alertsFor = async (who: string) =>
  (
    await owner.query(
      `SELECT payload FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND type = 'security' AND payload->>'event' = 'download' ORDER BY id DESC`,
      [fx.tenantId, fx.user(who).id],
    )
  ).rows.map((r) => r.payload as Record<string, unknown>);

const activeSuperAdmins = async () =>
  (
    await owner.query(
      `SELECT u.id, u.name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.tenant_id = $1 AND r.system_key = 'super_admin' AND u.status = 'active'`,
      [fx.tenantId],
    )
  ).rows as { id: string; name: string }[];

describe('download alerts to Super Admins', () => {
  it('tells every Super Admin when an Admin exports leads, naming the person and the file', async () => {
    const before = (await alertsFor('lockme')).length;
    const res = await api.call('GET', '/leads/export?format=csv', t.admin!, undefined, OFFICE_IP);
    expect(res.statusCode).toBe(200);

    for (const sa of await activeSuperAdmins()) {
      const mine = await owner.query(
        `SELECT payload FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND payload->>'event' = 'download' AND payload->>'userName' = 'admin' AND payload->>'kind' = 'lead_export'`,
        [fx.tenantId, sa.id],
      );
      expect(mine.rows.length, `Super Admin ${sa.name}`).toBeGreaterThanOrEqual(1);
    }
    const latest = (await alertsFor('lockme'))[0]!;
    expect(latest).toMatchObject({ event: 'download', kind: 'lead_export', userName: 'admin', userId: fx.user('admin').id });
    expect(String(latest.what)).toContain('lead list');
    expect(String(latest.fileName)).toMatch(/\.csv$/);
    expect((await alertsFor('lockme')).length).toBe(before + 1);
  });

  it('does not tell a Super Admin about their own download, but tells the others', async () => {
    const mineBefore = (await alertsFor('super')).length;
    const othersBefore = (await alertsFor('lockme')).length;
    expect((await api.call('GET', '/leads/export?format=csv', t.sa!)).statusCode).toBe(200);
    expect((await alertsFor('super')).length).toBe(mineBefore);
    expect((await alertsFor('lockme')).length).toBe(othersBefore + 1);
  });

  it('covers reports exported as a file, and does not alert for a report only viewed on screen', async () => {
    const before = (await alertsFor('lockme')).length;
    expect((await api.call('GET', '/reports/leads?groupBy=source', t.admin!, undefined, OFFICE_IP)).statusCode).toBe(200);
    expect((await alertsFor('lockme')).length).toBe(before);

    expect((await api.call('GET', '/reports/leads?groupBy=source&format=xlsx', t.admin!, undefined, OFFICE_IP)).statusCode).toBe(200);
    const after = await alertsFor('lockme');
    expect(after.length).toBe(before + 1);
    expect(after[0]).toMatchObject({ kind: 'report_export', userName: 'admin' });
  });

  it('is not written when the download is refused', async () => {
    const before = (await alertsFor('lockme')).length;
    const res = await api.call('GET', '/leads/export?format=csv', 'not.a.token');
    expect(res.statusCode).toBe(401);
    const counsellor = await api.signIn('counsellor', { office: true });
    expect((await api.call('GET', '/reports/leads?groupBy=source&format=csv', counsellor, undefined, OFFICE_IP)).statusCode).toBe(403);
    expect((await alertsFor('lockme')).length).toBe(before);
  });

  it('covers the monthly salary report with the same alert', async () => {
    const before = (await alertsFor('lockme')).length;
    const report = await api.call('GET', '/salaries/report?month=2026-10&format=csv', t.admin!, undefined, OFFICE_IP);
    // Whether the month has rows or not, a file is produced and the download is announced.
    expect(report.statusCode, report.body).toBe(200);
    const after = await alertsFor('lockme');
    expect(after.length).toBe(before + 1);
    expect(after[0]).toMatchObject({ kind: 'salary_export' });
  });
});
