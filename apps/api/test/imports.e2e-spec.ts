import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import writeXlsxFile from 'write-excel-file/node';
import { ImportsService } from '../src/imports/imports.service.js';
import { startApp } from './helpers/app.js';
import { Client, makeClient } from './helpers/client.js';
import { createFixture, Fixture } from './helpers/fixtures.js';
import { multipart, UploadFile } from './helpers/multipart.js';

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
  for (const name of ['admin', 'admin2', 'lc1', 'lc2']) t[name] = await api.signIn(name, { office: true });
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.end();
});

// ------------------------------------------------------------------ helpers

let counter = 0;
/** A valid, never-repeated Indian mobile number. */
const phone = () => `9${String(500_000_000 + ++counter).padStart(9, '0')}`;
const errorCode = (res: { json: () => { error?: { code?: string } } }) => res.json().error?.code;
const csv = (...lines: string[]) => Buffer.from(lines.join('\n') + '\n', 'utf8');
const file = (data: Buffer, filename = 'leads.csv'): UploadFile => ({ filename, data });

function post(token: string, path: string, fields: Record<string, string>, files: UploadFile[]) {
  const { payload, contentType } = multipart(fields, files);
  return app.inject({ method: 'POST', url: `/api/v1/leads/import${path}`, payload, headers: { authorization: `Bearer ${token}`, 'content-type': contentType } });
}
const preview = (token: string, f: UploadFile, fields: Record<string, string> = {}) => post(token, '/preview', fields, [f]);
const start = (token: string, f: UploadFile, fields: Record<string, string> = {}) => post(token, '', { sourceId: fx.sourceId('Meta Ads'), ...fields }, [f]);

type Batch = { id: string; status: string; totals: Record<string, number>; assigned: Record<string, number>; assign: { mode: string } };
async function finished(token: string, id: string): Promise<Batch> {
  for (let i = 0; i < 100; i++) {
    const res = await api.call('GET', `/leads/import/${id}`, token);
    expect(res.statusCode, res.body).toBe(200);
    if (res.json().status === 'done') return res.json();
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('import did not finish');
}
async function runImport(token: string, f: UploadFile, fields: Record<string, string> = {}) {
  const res = await start(token, f, fields);
  expect(res.statusCode, res.body).toBe(202);
  return finished(token, res.json().id);
}
const leadByPhone = async (p: string) => (await owner.query(`SELECT * FROM leads WHERE tenant_id = $1 AND primary_phone = $2 AND deleted_at IS NULL`, [fx.tenantId, `91${p}`])).rows[0];
const leadCount = async () => Number((await owner.query(`SELECT count(*) FROM leads WHERE tenant_id = $1`, [fx.tenantId])).rows[0].count);
const setPolicy = (duplicateAction: 'attach' | 'reject') =>
  owner.query(
    `INSERT INTO lead_policies (tenant_id, duplicate_action, auto_assign) VALUES ($1, $2, true)
     ON CONFLICT (tenant_id) DO UPDATE SET duplicate_action = EXCLUDED.duplicate_action`,
    [fx.tenantId, duplicateAction],
  );

// ================================================================== preview

describe('previewing a file', () => {
  it('says what would happen and saves nothing', async () => {
    const dup = phone();
    const before = await leadCount();
    await api.call('POST', '/leads', t.lc1!, { name: 'Already Here', phone: dup, sourceId: fx.sourceId('Website') });
    const res = await preview(
      t.admin!,
      file(csv('Student Name,Mobile No.,E-mail,Course,Remarks', `Riya,${phone()},riya@example.com,B.Tech,call late`, `Asha,${dup},,MBA,`, `Repeat,${dup},,,`, 'No Phone,,,,', 'Bad Phone,12345,,,')),
    );
    expect(res.statusCode, res.body).toBe(200);
    const p = res.json();
    expect(p.mapping).toEqual({ name: 'Student Name', phone: 'Mobile No.', email: 'E-mail', interest: 'Course' });
    expect(p.unmappedColumns).toEqual(['Remarks']);
    expect(p.missing).toEqual([]);
    expect(p.totals).toEqual({ rows: 5, valid: 3, invalid: 2, repeatedInFile: 1, alreadyInCrm: 1 });
    expect(p.problems.map((x: { row: number }) => x.row)).toEqual([5, 6]);
    expect(p.sample).toHaveLength(3);
    expect(await leadCount()).toBe(before + 1); // only the lead made by hand above
    expect((await api.call('GET', '/leads/import', t.admin!)).json()).toEqual([]);
  });

  it('asks for a column the file does not have, and accepts the person naming it', async () => {
    const data = csv('Candidate,Number', `Riya,${phone()}`);
    const first = await preview(t.admin!, file(data));
    expect(first.json().missing).toEqual(['name', 'phone']);
    expect(first.json().totals.valid).toBe(0);
    const fixed = await preview(t.admin!, file(data), { mapping: JSON.stringify({ name: 'Candidate', phone: 'Number' }) });
    expect(fixed.json()).toMatchObject({ missing: [], totals: { valid: 1, invalid: 0 } });
  });

  it('reads an Excel file the same way, keeping long numbers whole', async () => {
    const xlsx = await writeXlsxFile([
      [{ value: 'Name' }, { value: 'Mobile' }],
      [{ value: 'Riya', type: String }, { value: 919876543210 }],
    ]).toBuffer();
    const res = await preview(t.admin!, file(xlsx, 'leads.xlsx'));
    expect(res.json()).toMatchObject({ fileName: 'leads.xlsx', totals: { valid: 1 }, sample: [{ name: 'Riya', phone: '919876543210' }] });
  });

  it.each([
    ['a program named like a spreadsheet', file(Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)]), 'leads.csv'), 415, 'NOT_A_SPREADSHEET'],
    ['an old .xls file', file(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.alloc(200)]), 'leads.xls'), 415, 'OLD_EXCEL'],
    ['a file that is not UTF-8', file(Buffer.from([0x4e, 0x0a, 0x52, 0xe9, 0x0a]), 'leads.csv'), 400, 'NOT_UTF8'],
    ['an empty file', file(Buffer.alloc(0)), 400, 'EMPTY_SHEET'],
  ])('refuses %s', async (_n, f, status, code) => {
    const res = await preview(t.admin!, f);
    expect(res.statusCode, res.body).toBe(status);
    expect(errorCode(res)).toBe(code);
  });

  it('refuses a file over the size limit', async () => {
    const big = Buffer.from('Name,Mobile\n' + 'x'.repeat(2 * 1024 * 1024 + 10));
    const res = await preview(t.admin!, file(big));
    expect(res.statusCode).toBe(413);
    expect(errorCode(res)).toBe('FILE_TOO_LARGE');
  });

  it('refuses a request that is not an upload, or has no file, or bad column choices', async () => {
    expect(errorCode(await app.inject({ method: 'POST', url: '/api/v1/leads/import/preview', payload: {}, headers: { authorization: `Bearer ${t.admin}` } }))).toBe('NOT_MULTIPART');
    expect(errorCode(await post(t.admin!, '/preview', {}, []))).toBe('NO_FILE');
    expect(errorCode(await preview(t.admin!, file(csv('Name,Mobile', `a,${phone()}`)), { mapping: 'not json' }))).toBe('VALIDATION_FAILED');
    expect(errorCode(await preview(t.admin!, file(csv('Name,Mobile', `a,${phone()}`)), { mapping: JSON.stringify({ salary: 'Name' }) }))).toBe('VALIDATION_FAILED');
  });
});

// ================================================================== import

describe('importing leads', () => {
  it('files every good row, gives them to the chosen person, and reports the rest', async () => {
    await setPolicy('attach');
    const [a, b] = [phone(), phone()];
    const data = csv('Name,Phone,Email,City', `Riya Sharma,${a},riya@example.com,Delhi`, `Asha K,+91 ${b.slice(0, 5)} ${b.slice(5)},,`, 'No Phone,,,', 'Bad,123,,');
    const res = await start(t.admin!, file(data, 'October Batch.csv'), { assign: 'user', userId: fx.user('lc1').id });
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json()).toMatchObject({ fileName: 'October Batch.csv', status: expect.stringMatching(/queued|processing|done/), source: { name: 'Meta Ads' }, assign: { mode: 'user', user: { name: 'lc1' } } });

    const done = await finished(t.admin!, res.json().id);
    expect(done.totals).toEqual({ rows: 4, invalid: 2, toFile: 2, processed: 2, created: 2, attached: 0, rejected: 0, failed: 0 });
    expect(done.assigned).toEqual({ [fx.user('lc1').id]: 2 });

    const lead = await leadByPhone(a);
    expect(lead).toMatchObject({ name: 'Riya Sharma', email: 'riya@example.com', assigned_to: fx.user('lc1').id });
    expect((await leadByPhone(b)).assigned_to).toBe(fx.user('lc1').id);
    const source = (await owner.query(`SELECT s.name FROM lead_sources s WHERE s.id = $1`, [lead.source_id])).rows[0].name;
    expect(source).toBe('Meta Ads');
    const enquiry = (await owner.query(`SELECT form_name FROM lead_enquiries WHERE lead_id = $1`, [lead.id])).rows[0];
    expect(enquiry.form_name).toBe('import: October Batch.csv');

    const trail = (await api.call('GET', `/leads/${lead.id}/activities?limit=50`, t.lc1!)).json().items.map((x: { type: string; remark: string }) => `${x.type}:${x.remark}`);
    expect(trail).toContain('assignment:Assigned to lc1');
  });

  it('sends one summary instead of a notification for every lead', async () => {
    const rows = Array.from({ length: 6 }, (_v, i) => `Bulk ${i},${phone()}`);
    const done = await runImport(t.admin!, file(csv('Name,Phone', ...rows)), { assign: 'user', userId: fx.user('lc2').id });
    expect(done.totals.created).toBe(6);

    const lc2 = (await owner.query(`SELECT type, payload FROM notifications WHERE user_id = $1 AND payload->>'batchId' = $2`, [fx.user('lc2').id, done.id])).rows;
    expect(lc2).toHaveLength(1);
    expect(lc2[0]).toMatchObject({ type: 'assignment', payload: { event: 'leads_imported', count: 6 } });
    const mine = (await owner.query(`SELECT payload FROM notifications WHERE user_id = $1 AND payload->>'batchId' = $2`, [fx.user('admin').id, done.id])).rows;
    expect(mine).toHaveLength(1);
    expect(mine[0].payload).toMatchObject({ event: 'import_finished', created: 6, attached: 0, failed: 0 });
    const perLead = (await owner.query(`SELECT count(*) FROM notifications WHERE tenant_id = $1 AND payload->>'event' = 'lead_assigned' AND payload->>'name' LIKE 'Bulk %'`, [fx.tenantId])).rows[0].count;
    expect(Number(perLead)).toBe(0);
  });

  it('can leave leads in the unassigned pool', async () => {
    const p = phone();
    const done = await runImport(t.admin!, file(csv('Name,Phone', `Pool Lead,${p}`)), { assign: 'none' });
    expect(done.assigned).toEqual({ unassigned: 1 });
    expect((await leadByPhone(p)).assigned_to).toBeNull();
  });

  it("follows the company's automatic assignment when asked", async () => {
    const phones = [phone(), phone(), phone()];
    const done = await runImport(t.admin!, file(csv('Name,Phone', ...phones.map((p, i) => `Auto ${i},${p}`))), { assign: 'auto' });
    expect(done.totals.created).toBe(3);
    const givenOut = Object.values(done.assigned).reduce((n, c) => n + c, 0);
    expect(givenOut).toBe(3);
    for (const p of phones) {
      const row = await leadByPhone(p);
      expect(row.assigned_to === null).toBe(done.assigned.unassigned === 3);
    }
  });

  it('adds a repeat to the lead that already has the number, and keeps the first', async () => {
    await setPolicy('attach');
    const known = phone();
    const first = (await api.call('POST', '/leads', t.lc1!, { name: 'First Name', phone: known, sourceId: fx.sourceId('Website') })).json();
    const fresh = phone();
    const done = await runImport(t.admin!, file(csv('Name,Phone', `Other Name,${known}`, `New One,${fresh}`, `New One Again,${fresh}`)), { assign: 'none' });
    expect(done.totals).toMatchObject({ created: 1, attached: 2, rejected: 0 });
    expect((await leadByPhone(known)).name).toBe('First Name');
    expect((await leadByPhone(fresh)).name).toBe('New One');
    const enquiries = (await owner.query(`SELECT count(*) FROM lead_enquiries WHERE lead_id = $1`, [first.id])).rows[0].count;
    expect(Number(enquiries)).toBe(1);
  });

  it('refuses a repeat when the company asks for that', async () => {
    await setPolicy('reject');
    try {
      const known = phone();
      await api.call('POST', '/leads', t.lc1!, { name: 'Keep Me', phone: known, sourceId: fx.sourceId('Website') });
      const before = await leadCount();
      const done = await runImport(t.admin!, file(csv('Name,Phone', `Dup,${known}`)), { assign: 'none' });
      expect(done.totals).toMatchObject({ created: 0, attached: 0, rejected: 1 });
      expect(await leadCount()).toBe(before);
    } finally {
      await setPolicy('attach');
    }
  });

  it('imports an Excel file', async () => {
    const p = phone();
    const xlsx = await writeXlsxFile([
      [{ value: 'Name' }, { value: 'Mobile' }, { value: 'City' }],
      [{ value: 'Excel Lead', type: String }, { value: `91${p}`, type: String }, { value: 'Pune', type: String }],
    ]).toBuffer();
    const done = await runImport(t.admin!, file(xlsx, 'leads.xlsx'), { assign: 'none' });
    expect(done.totals.created).toBe(1);
    expect((await leadByPhone(p)).name).toBe('Excel Lead');
  });

  it('keeps Hindi names intact', async () => {
    const p = phone();
    await runImport(t.admin!, file(csv('नाम,मोबाइल नंबर,Phone', `सिया शर्मा,,${p}`)), { assign: 'none' });
    expect((await leadByPhone(p)).name).toBe('सिया शर्मा');
  });

  it('gives a CSV of the rows that were left out, safe to open in a spreadsheet', async () => {
    const res = await start(t.admin!, file(csv('Name,Phone', `Good,${phone()}`, `=HYPERLINK("http://evil.example"),123`, 'Plain Bad,'), 'mixed.csv'), { assign: 'none' });
    const done = await finished(t.admin!, res.json().id);
    expect(done.totals).toMatchObject({ invalid: 2, created: 1 });

    const report = await api.call('GET', `/leads/import/${done.id}/problems.csv`, t.admin!);
    expect(report.statusCode).toBe(200);
    expect(report.headers['content-type']).toContain('text/csv');
    expect(report.headers['content-disposition']).toContain('mixed-problems.csv');
    expect(report.body.startsWith('﻿Row,Name,Phone,Problem\r\n')).toBe(true);
    const lines = report.body.split('\r\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("'=HYPERLINK"); // shown as text, not run as a formula
    expect(lines[2]).toMatch(/^4,Plain Bad,,/);
  });

  it('rejects what is wrong with the request before queueing anything', async () => {
    const good = file(csv('Name,Phone', `A,${phone()}`));
    const bad = async (fields: Record<string, string | undefined>, f = good) =>
      post(t.admin!, '', Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Record<string, string>, [f]);

    expect(errorCode(await bad({}))).toBe('VALIDATION_FAILED'); // no source
    expect(errorCode(await bad({ sourceId: 'nope' }))).toBe('VALIDATION_FAILED');
    expect(errorCode(await bad({ sourceId: fx.sourceId('Meta Ads'), assign: 'user' }))).toBe('VALIDATION_FAILED'); // user without userId
    expect(errorCode(await bad({ sourceId: fx.sourceId('Meta Ads'), assign: 'none', userId: fx.user('lc1').id }))).toBe('VALIDATION_FAILED');
    expect(errorCode(await bad({ sourceId: '0197f000-0000-7000-8000-000000000000' }))).toBe('SOURCE_INVALID');
    const stranger = await bad({ sourceId: fx.sourceId('Meta Ads'), assign: 'user', userId: '0197f000-0000-7000-8000-000000000000' });
    expect(errorCode(stranger)).toBe('ASSIGNEE_INVALID');

    const noPhoneCol = await bad({ sourceId: fx.sourceId('Meta Ads') }, file(csv('Candidate,Number', 'a,1')));
    expect(noPhoneCol.statusCode).toBe(422);
    expect(errorCode(noPhoneCol)).toBe('MAPPING_INCOMPLETE');
    expect(noPhoneCol.json().error.details).toMatchObject({ missing: ['name', 'phone'] });

    const allBad = await bad({ sourceId: fx.sourceId('Meta Ads') }, file(csv('Name,Phone', 'a,1', 'b,2')));
    expect(allBad.statusCode).toBe(422);
    expect(errorCode(allBad)).toBe('NOTHING_TO_IMPORT');
    expect(allBad.json().error.details.problems).toHaveLength(2);

    expect(errorCode(await bad({ sourceId: fx.sourceId('Meta Ads') }, file(csv('Name,Phone'))))).toBe('EMPTY_SHEET');
  });

  it('does not file a row twice when several workers pick up the same batch', async () => {
    const rows = Array.from({ length: 60 }, (_v, i) => `Race ${i},${phone()}`);
    const res = await start(t.admin!, file(csv('Name,Phone', ...rows)), { assign: 'none' });
    const svc = app.get(ImportsService);
    await Promise.all([svc.process(fx.tenantId, res.json().id), svc.process(fx.tenantId, res.json().id), svc.process(fx.tenantId, res.json().id)]);
    const done = await finished(t.admin!, res.json().id);
    expect(done.totals).toMatchObject({ processed: 60, created: 60, failed: 0 });
    const count = (await owner.query(`SELECT count(*) FROM leads WHERE tenant_id = $1 AND name LIKE 'Race %'`, [fx.tenantId])).rows[0].count;
    expect(Number(count)).toBe(60);
    const stored = (await owner.query(`SELECT rows FROM lead_import_batches WHERE id = $1`, [done.id])).rows[0].rows;
    expect(stored).toEqual([]); // the waiting rows are cleared once finished
  });
});

// ================================================================== access

describe('who may import', () => {
  it('needs the import permission', async () => {
    const f = file(csv('Name,Phone', `A,${phone()}`));
    expect((await preview(t.lc1!, f)).statusCode).toBe(403);
    expect((await start(t.lc1!, f)).statusCode).toBe(403);
    expect((await api.call('GET', '/leads/import', t.lc1!)).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/leads/import' })).statusCode).toBe(401);
  });

  it('shows a person their own imports; an Admin of another team cannot see them, a Super Admin can', async () => {
    const done = await runImport(t.admin!, file(csv('Name,Phone', `Mine,${phone()}`)), { assign: 'none' });
    expect((await api.call('GET', `/leads/import/${done.id}`, t.admin!)).statusCode).toBe(200);
    expect((await api.call('GET', `/leads/import/${done.id}`, t.sa!)).statusCode).toBe(200);
    expect((await api.call('GET', `/leads/import/${done.id}`, t.admin2!)).statusCode).toBe(404);
    expect((await api.call('GET', `/leads/import/${done.id}/problems.csv`, t.admin2!)).statusCode).toBe(404);
    expect((await api.call('GET', '/leads/import', t.admin2!)).json().map((b: { id: string }) => b.id)).not.toContain(done.id);
    expect((await api.call('GET', '/leads/import', t.sa!)).json().map((b: { id: string }) => b.id)).toContain(done.id);
  });
});
