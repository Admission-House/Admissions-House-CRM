import { parse } from 'csv-parse/sync';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { readSheet } from 'read-excel-file/node';
import { startApp } from './helpers/app.js';
import { Client, makeClient } from './helpers/client.js';
import { createFixture, Fixture } from './helpers/fixtures.js';
import { multipart } from './helpers/multipart.js';

let app: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;
let api: Client;
const t: Record<string, string> = {};
const MONTH = new Date().toISOString().slice(0, 7);
const PREVIOUS = (() => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
})();

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  app = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500' });
  api = makeClient(app, fx);
  t.sa = await api.signIn('super');
  for (const name of ['admin', 'admin2', 'lc1', 'lc2']) t[name] = await api.signIn(name, { office: true });
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.end();
});

const errorCode = (res: { json: () => { error?: { code?: string } } }) => res.json().error?.code;
const pay = (who: string, month = MONTH, extra: Record<string, unknown> = {}) => ({ userId: fx.user(who).id, month, basePay: 30000, allowances: 2500.5, deductions: 1200.25, ...extra });
const put = (token: string, body: unknown) => api.call('PUT', '/salaries', token, body as never);
const emailOf = async (who: string) => (await owner.query(`SELECT email FROM users WHERE id = $1`, [fx.user(who).id])).rows[0].email as string;
function sheet(token: string, path: string, month: string, csv: string) {
  const { payload, contentType } = multipart({ month }, [{ filename: 'salaries.csv', data: Buffer.from(csv) }]);
  return app.inject({ method: 'POST', url: `/api/v1/salaries/import${path}`, payload, headers: { authorization: `Bearer ${token}`, 'content-type': contentType } });
}

describe('entering a salary', () => {
  it('saves it, with net pay worked out by the database', async () => {
    const res = await put(t.admin!, pay('lc1'));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ month: MONTH, basePay: 30000, allowances: 2500.5, deductions: 1200.25, netPay: 31300.25, user: { name: 'lc1' }, enteredBy: 'admin' });
  });

  it('changes the same month again instead of adding a second record, and logs who changed what', async () => {
    const first = (await put(t.admin!, pay('lc2'))).json();
    const second = await put(t.sa!, pay('lc2', MONTH, { basePay: 35000, notes: 'Raise' }));
    expect(second.json().id).toBe(first.id);
    expect(second.json()).toMatchObject({ basePay: 35000, netPay: 36300.25, notes: 'Raise', enteredBy: 'super' });
    expect(Number((await owner.query(`SELECT count(*) FROM salary_records WHERE user_id = $1`, [fx.user('lc2').id])).rows[0].count)).toBe(1);

    const log = (await owner.query(`SELECT action, actor_id, before, after FROM audit_logs WHERE entity_id = $1 ORDER BY id`, [first.id])).rows;
    expect(log.map((l) => l.action)).toEqual(['salary.create', 'salary.update']);
    expect(log[1]).toMatchObject({ actor_id: fx.user('super').id, before: { basePay: 30000 }, after: { basePay: 35000, notes: 'Raise' } });
  });

  it('refuses amounts that make no sense', async () => {
    expect(errorCode(await put(t.admin!, pay('lc1', MONTH, { deductions: 99999 })))).toBe('NET_NEGATIVE');
    expect(errorCode(await put(t.admin!, pay('lc1', MONTH, { basePay: -1 })))).toBe('VALIDATION_FAILED');
    expect(errorCode(await put(t.admin!, pay('lc1', MONTH, { basePay: 100.123 })))).toBe('VALIDATION_FAILED');
    expect(errorCode(await put(t.admin!, pay('lc1', 'October')))).toBe('MONTH_INVALID');
    expect(errorCode(await put(t.admin!, pay('lc1', '2090-01')))).toBe('MONTH_IN_FUTURE');
  });

  it('stays within the Admin\'s team, and never for oneself', async () => {
    expect((await put(t.admin2!, pay('lc1'))).statusCode).toBe(404);
    expect((await put(t.admin!, { ...pay('lc1'), userId: fx.user('admin2').id })).statusCode).toBe(404);
    const own = await put(t.admin!, pay('admin'));
    expect(own.statusCode).toBe(403);
    expect(errorCode(own)).toBe('OWN_SALARY');
    expect((await put(t.lc1!, pay('lc2'))).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/api/v1/salaries', payload: pay('lc1') })).statusCode).toBe(401);
  });

  it('saves several employees together or none at all', async () => {
    const ok = await api.call('POST', '/salaries/bulk', t.admin!, { month: PREVIOUS, rows: [{ userId: fx.user('lc1').id, basePay: 20000 }, { userId: fx.user('lc2').id, basePay: 22000, deductions: 500 }] });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().saved.map((s: { netPay: number }) => s.netPay)).toEqual([20000, 21500]);

    const before = Number((await owner.query(`SELECT count(*) FROM salary_records WHERE tenant_id = $1`, [fx.tenantId])).rows[0].count);
    const bad = await api.call('POST', '/salaries/bulk', t.admin!, {
      month: '2026-01',
      rows: [{ userId: fx.user('lc1').id, basePay: 1000 }, { userId: fx.user('lc2').id, basePay: 100, deductions: 900 }, { userId: fx.user('admin2').id, basePay: 5 }, { userId: fx.user('lc1').id, basePay: 2 }],
    });
    expect(bad.statusCode).toBe(422);
    expect(errorCode(bad)).toBe('BULK_REJECTED');
    expect(bad.json().error.details.problems.map((p: { index: number }) => p.index)).toEqual([1, 2, 3]);
    expect(Number((await owner.query(`SELECT count(*) FROM salary_records WHERE tenant_id = $1`, [fx.tenantId])).rows[0].count)).toBe(before);
  });
});

describe('seeing salaries', () => {
  it('lets a person see only their own, and download the payslip', async () => {
    const mine = await api.call('GET', '/salaries/mine', t.lc1!);
    expect(mine.statusCode).toBe(200);
    expect(mine.json().length).toBeGreaterThanOrEqual(2);
    expect(mine.json().every((s: { user: { name: string } }) => s.user.name === 'lc1')).toBe(true);
    expect(mine.json()[0].month >= mine.json()[1].month).toBe(true); // newest first

    const id = mine.json()[0].id;
    expect((await api.call('GET', `/salaries/${id}`, t.lc1!)).statusCode).toBe(200);
    const pdf = await app.inject({ method: 'GET', url: `/api/v1/salaries/${id}/payslip.pdf`, headers: { authorization: `Bearer ${t.lc1}` } });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toContain('payslip-');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    const theirs = (await api.call('GET', '/salaries/mine', t.lc2!)).json()[0].id;
    expect((await api.call('GET', `/salaries/${theirs}`, t.lc1!)).statusCode).toBe(404);
    expect((await api.call('GET', `/salaries/${theirs}/payslip.pdf`, t.lc1!)).statusCode).toBe(404);
    expect((await api.call('GET', '/salaries', t.lc1!)).statusCode).toBe(403);
  });

  it('draws a payslip for a name in Hindi', async () => {
    await owner.query(`UPDATE users SET name = 'सिया शर्मा' WHERE id = $1`, [fx.user('lc2').id]);
    const id = (await api.call('GET', '/salaries/mine', t.lc2!)).json()[0].id;
    const pdf = await app.inject({ method: 'GET', url: `/api/v1/salaries/${id}/payslip.pdf`, headers: { authorization: `Bearer ${t.lc2}` } });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload.length).toBeGreaterThan(5000);
    await owner.query(`UPDATE users SET name = 'lc2' WHERE id = $1`, [fx.user('lc2').id]);
  });

  it('lets an Admin list the team, with filters and paging; another team sees nothing', async () => {
    const all = await api.call('GET', '/salaries?limit=100', t.admin!);
    expect(all.json().items.length).toBeGreaterThanOrEqual(4);
    const names = new Set(all.json().items.map((s: { user: { name: string } }) => s.user.name));
    expect([...names].sort()).toEqual(['lc1', 'lc2']);
    expect((await api.call('GET', `/salaries?month=${PREVIOUS}`, t.admin!)).json().items.every((s: { month: string }) => s.month === PREVIOUS)).toBe(true);
    expect((await api.call('GET', `/salaries?userId=${fx.user('lc1').id}`, t.admin!)).json().items.every((s: { user: { name: string } }) => s.user.name === 'lc1')).toBe(true);

    const p1 = await api.call('GET', '/salaries?limit=2', t.admin!);
    expect(p1.json().items).toHaveLength(2);
    const p2 = await api.call('GET', `/salaries?limit=2&cursor=${encodeURIComponent(p1.json().nextCursor)}`, t.admin!);
    expect(p2.json().items.map((s: { id: string }) => s.id)).not.toEqual(expect.arrayContaining(p1.json().items.map((s: { id: string }) => s.id)));

    expect((await api.call('GET', '/salaries', t.admin2!)).json().items).toEqual([]);
    expect((await api.call('GET', '/salaries?limit=100', t.sa!)).json().items.length).toBeGreaterThanOrEqual(all.json().items.length);
    expect(errorCode(await api.call('GET', '/salaries?month=nope', t.admin!))).toBe('MONTH_INVALID');
  });

  it('shows the month\'s attendance beside a record, for reference only', async () => {
    const id = (await put(t.admin!, pay('lc1'))).json().id;
    const d = await api.call('GET', `/salaries/${id}`, t.admin!);
    expect(d.json().attendance).toMatchObject({ userId: fx.user('lc1').id });
    const a = d.json().attendance;
    expect(a.present).toBeGreaterThanOrEqual(1); // signing in at the office counted as today's attendance
    expect(a.absent).toBe(Math.max(0, a.workingDays - a.present - a.leaveDays));
    expect(d.json().netPay).toBe(31300.25); // attendance did not touch the amount
  });

  it('exports the report as CSV and Excel, safe to open', async () => {
    await put(t.sa!, pay('lc1', PREVIOUS, { notes: '=HYPERLINK("http://evil.example")' }));
    const csv = await api.call('GET', `/salaries/report?month=${PREVIOUS}`, t.admin!);
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
    const rows = parse(csv.body, { bom: true, columns: true }) as Record<string, string>[];
    expect(rows.map((r) => r.Employee).sort()).toEqual(['lc1', 'lc2']);
    expect(rows.find((r) => r.Employee === 'lc1')!.Notes).toBe(`'=HYPERLINK("http://evil.example")`);

    const xlsx = await app.inject({ method: 'GET', url: `/api/v1/salaries/report?month=${PREVIOUS}&format=xlsx`, headers: { authorization: `Bearer ${t.admin}` } });
    const grid = await readSheet(xlsx.rawPayload);
    expect(grid[0]).toContain('Net Pay');
    expect(grid).toHaveLength(3);
    expect((await api.call('GET', '/salaries/report', t.lc1!)).statusCode).toBe(403);
  });
});

describe('importing a salary sheet', () => {
  it('previews, then saves the good rows and reports the rest', async () => {
    const csv = ['Email,Basic Salary,Allowances,Deductions,Remarks', `${await emailOf('lc1')},"₹ 40,000",1000,500,Oct`, `${await emailOf('lc2')},25000,,,`, 'nobody@example.com,100,,,', `${await emailOf('admin2')},100,,,`, `${await emailOf('admin')},100,,,`, 'bad,x,,,'].join('\n');
    const month = '2026-02';
    const preview = await sheet(t.admin!, '/preview', month, csv);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({ month, rows: 6, toAdd: 2, toChange: 0, applied: false });
    expect(preview.json().problems.map((p: { row: number }) => p.row)).toEqual([4, 5, 6, 7]);
    expect(Number((await owner.query(`SELECT count(*) FROM salary_records WHERE month = '2026-02-01'`)).rows[0].count)).toBe(0);

    const done = await sheet(t.admin!, '', month, csv);
    expect(done.json()).toMatchObject({ applied: true, toAdd: 2, problems: expect.any(Array) });
    const saved = (await owner.query(`SELECT u.name, s.net_pay::float AS net, s.batch_id FROM salary_records s JOIN users u ON u.id = s.user_id WHERE s.month = '2026-02-01' ORDER BY u.name`)).rows;
    expect(saved).toEqual([{ name: 'lc1', net: 40500, batch_id: done.json().batchId }, { name: 'lc2', net: 25000, batch_id: done.json().batchId }]);
    expect((await owner.query(`SELECT rows_total, rows_ok, rows_failed FROM salary_import_batches WHERE id = $1`, [done.json().batchId])).rows[0]).toEqual({ rows_total: 6, rows_ok: 2, rows_failed: 4 });

    const again = await sheet(t.admin!, '/preview', month, csv);
    expect(again.json()).toMatchObject({ toAdd: 0, toChange: 2 });
  });

  it('asks for the columns it needs, and checks the month and the permission', async () => {
    const noCols = await sheet(t.admin!, '', MONTH, 'Name,Pay\na,1\n');
    expect(noCols.statusCode).toBe(422);
    expect(errorCode(noCols)).toBe('MAPPING_INCOMPLETE');
    expect(errorCode(await sheet(t.admin!, '', 'soon', 'Email,Base Pay\n'))).toBe('MONTH_INVALID');
    expect((await sheet(t.lc1!, '', MONTH, 'Email,Base Pay\n')).statusCode).toBe(403);
  });
});
