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

let counter = 0;
const phone = () => `9${String(700_000_000 + ++counter).padStart(9, '0')}`;
const errorCode = (res: { json: () => { error?: { code?: string } } }) => res.json().error?.code;
const lead = async (token: string, name: string, extra: Record<string, unknown> = {}) => {
  const res = await api.call('POST', '/leads', token, { name, phone: phone(), sourceId: fx.sourceId('Website'), ...extra });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
};
const rowsOf = (body: string) => parse(body, { bom: true, columns: true }) as Record<string, string>[];

describe('exporting leads', () => {
  it('writes the leads the person can see, in the same shape the import reads', async () => {
    const mine = await lead(t.lc1!, 'Export Mine', { email: 'mine@example.com', intent: 'hot', studyMode: 'online' });
    await lead(t.lc2!, 'Export Theirs');
    const res = await api.call('GET', '/leads/export?q=Export', t.admin!);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="leads-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.body.startsWith('﻿Lead No,Name,Phone,')).toBe(true);

    const rows = rowsOf(res.body);
    expect(rows.map((r) => r.Name).sort()).toEqual(['Export Mine', 'Export Theirs']);
    const row = rows.find((r) => r.Name === 'Export Mine')!;
    expect(row).toMatchObject({ 'Lead No': mine.leadNo, Email: 'mine@example.com', Status: 'New', Source: 'Website', Intent: 'hot', 'Study Mode': 'online', 'Assigned To': 'lc1' });
    expect(row.Phone).toMatch(/^91 \d{5} \d{5}$/);
    expect(row.Created).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('follows the filters and the data scope', async () => {
    await lead(t.lc1!, 'Scope A');
    await lead(t.lc2!, 'Scope B');

    const both = rowsOf((await api.call('GET', '/leads/export?q=Scope', t.admin!)).body);
    expect(both.map((r) => r.Name).sort()).toEqual(['Scope A', 'Scope B']);
    const onlyLc2 = rowsOf((await api.call('GET', `/leads/export?q=Scope&assignedTo=${fx.user('lc2').id}`, t.admin!)).body);
    expect(onlyLc2.map((r) => r.Name)).toEqual(['Scope B']);
    expect(rowsOf((await api.call('GET', '/leads/export?q=Scope', t.admin2!)).body)).toEqual([]);
    expect(rowsOf((await api.call('GET', '/leads/export?q=Nothing-matches-this', t.admin!)).body)).toEqual([]);
  });

  it('keeps text that looks like a formula from running when the file is opened', async () => {
    await lead(t.lc1!, '=HYPERLINK("http://evil.example","x")');
    await lead(t.lc1!, '@SUM(1+1)');
    const link = rowsOf((await api.call('GET', '/leads/export?q=HYPERLINK', t.admin!)).body);
    expect(link[0]!.Name).toBe(`'=HYPERLINK("http://evil.example","x")`);
    const at = rowsOf((await api.call('GET', '/leads/export?q=SUM', t.admin!)).body);
    expect(at[0]!.Name).toBe("'@SUM(1+1)");
  });

  it('gives an Excel file when asked', async () => {
    await lead(t.lc1!, 'Excel Export');
    const res = await app.inject({ method: 'GET', url: '/api/v1/leads/export?q=Excel%20Export&format=xlsx', headers: { authorization: `Bearer ${t.admin}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(res.headers['content-disposition']).toContain('.xlsx');
    const sheet = await readSheet(res.rawPayload);
    expect(sheet[0]![1]).toBe('Name');
    expect(sheet[1]![1]).toBe('Excel Export');
    expect(String(sheet[1]![2])).toMatch(/^91 \d{5} \d{5}$/);
  });

  it('can be imported again: the phone column reads back as the same number', async () => {
    const created = await lead(t.lc1!, 'Round Trip');
    const exported = (await api.call('GET', '/leads/export?q=Round%20Trip', t.admin!)).body;
    await owner.query(`DELETE FROM lead_enquiries WHERE lead_id = $1`, [created.id]);
    await owner.query(`DELETE FROM lead_activities WHERE lead_id = $1`, [created.id]);
    await owner.query(`DELETE FROM leads WHERE id = $1`, [created.id]);

    const { payload, contentType } = multipart({ sourceId: fx.sourceId('Meta Ads'), assign: 'none' }, [{ filename: 'back.csv', data: Buffer.from(exported) }]);
    const res = await app.inject({ method: 'POST', url: '/api/v1/leads/import', payload, headers: { authorization: `Bearer ${t.admin}`, 'content-type': contentType } });
    expect(res.statusCode, res.body).toBe(202);
    for (let i = 0; i < 50; i++) {
      const s = await api.call('GET', `/leads/import/${res.json().id}`, t.admin!);
      if (s.json().status === 'done') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const back = (await owner.query(`SELECT primary_phone FROM leads WHERE tenant_id = $1 AND name = 'Round Trip' AND deleted_at IS NULL`, [fx.tenantId])).rows;
    expect(back).toHaveLength(1);
    expect(back[0]!.primary_phone).toBe(rowsOf(exported)[0]!.Phone!.replace(/ /g, ""));
  });

  it('writes who exported what to the audit log', async () => {
    await api.call('GET', '/leads/export?q=Export%20Mine&intent=hot', t.admin!);
    const entry = (await owner.query(`SELECT actor_id, after FROM audit_logs WHERE tenant_id = $1 AND action = 'lead.export' ORDER BY id DESC LIMIT 1`, [fx.tenantId])).rows[0];
    expect(entry.actor_id).toBe(fx.user('admin').id);
    expect(entry.after).toMatchObject({ count: 1, format: 'csv', filters: { q: 'Export Mine', intent: 'hot' } });
  });

  it('needs the export permission, and rejects bad filters', async () => {
    expect((await api.call('GET', '/leads/export', t.lc1!)).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/leads/export' })).statusCode).toBe(401);
    expect(errorCode(await api.call('GET', '/leads/export?format=pdf', t.admin!))).toBe('VALIDATION_FAILED');
    expect(errorCode(await api.call('GET', '/leads/export?sourceId=nope', t.admin!))).toBe('VALIDATION_FAILED');
  });
});
