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
const stored = async (who: string) => (await owner.query(`SELECT * FROM user_profiles WHERE user_id = $1`, [fx.user(who).id])).rows[0];

describe('my profile', () => {
  it('is empty at first, then holds what I add, with the account number masked', async () => {
    const empty = await api.call('GET', '/me/profile', t.lc1!);
    expect(empty.statusCode, empty.body).toBe(200);
    expect(empty.json()).toMatchObject({ name: 'lc1', designation: null, bankAccountNo: null });

    const saved = await api.call('PUT', '/me/profile', t.lc1!, {
      address: '12 Park Road, Delhi', emergencyContactName: 'Sunita', emergencyContactPhone: '98100 00099', bankName: 'HDFC Bank', bankAccountNo: '123456789012', bankIfsc: 'hdfc0001234',
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ address: '12 Park Road, Delhi', emergencyContactPhone: '919810000099', bankName: 'HDFC Bank', bankAccountNo: '********9012', bankIfsc: 'HDFC0001234' });
  });

  it('stores the bank details encrypted, and keeps them out of the audit log', async () => {
    const row = await stored('lc1');
    expect(row.bank_account_no_enc).toMatch(/^v1\./);
    expect(row.bank_ifsc_enc).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toContain('123456789012');
    expect(JSON.stringify(row)).not.toContain('HDFC0001234');
    const log = JSON.stringify((await owner.query(`SELECT before, after FROM audit_logs WHERE tenant_id = $1 AND action = 'profile.update'`, [fx.tenantId])).rows);
    expect(log).not.toContain('123456789012');
    expect(log).not.toContain('HDFC0001234');
    expect(log).toContain('(changed)');
  });

  it('shows the full number only when asked, to the owner, and records it', async () => {
    const full = await api.call('GET', '/me/profile?reveal=true', t.lc1!);
    expect(full.json().bankAccountNo).toBe('123456789012');
    const entry = (await owner.query(`SELECT actor_id, entity_id FROM audit_logs WHERE tenant_id = $1 AND action = 'profile.reveal_bank'`, [fx.tenantId])).rows;
    expect(entry).toEqual([{ actor_id: fx.user('lc1').id, entity_id: fx.user('lc1').id }]);
  });

  it('changes only what is sent, and clears with null', async () => {
    const res = await api.call('PUT', '/me/profile', t.lc1!, { address: null });
    expect(res.json()).toMatchObject({ address: null, bankName: 'HDFC Bank', bankAccountNo: '********9012' });
  });

  it('refuses bad details and fields only HR may set', async () => {
    for (const bad of [{ bankAccountNo: '12ab' }, { bankIfsc: 'NOTANIFSC' }, { emergencyContactPhone: '123' }, { address: 'x'.repeat(501) }, {}]) {
      expect(errorCode(await api.call('PUT', '/me/profile', t.lc1!, bad))).toBe('VALIDATION_FAILED');
    }
    expect(errorCode(await api.call('PUT', '/me/profile', t.lc1!, { designation: 'Manager' }))).toBe('VALIDATION_FAILED');
    expect((await stored('lc1')).designation).toBeNull();
  });
});

describe('someone else\'s profile', () => {
  it('lets a Super Admin set HR details and see the masked bank number', async () => {
    const res = await api.call('PUT', `/users/${fx.user('lc1').id}/profile`, t.sa!, { designation: 'Senior Counsellor', dateOfBirth: '1996-04-12' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ designation: 'Senior Counsellor', dateOfBirth: '1996-04-12', bankAccountNo: '********9012' });
    expect((await api.call('GET', `/users/${fx.user('lc1').id}/profile`, t.sa!)).json().bankAccountNo).toBe('********9012');
  });

  it('lets someone who enters salaries see the full number, once logged', async () => {
    const res = await api.call('GET', `/users/${fx.user('lc1').id}/profile?reveal=true`, t.admin!);
    expect(res.json().bankAccountNo).toBe('123456789012');
    const logged = (await owner.query(`SELECT count(*) FROM audit_logs WHERE tenant_id = $1 AND action = 'profile.reveal_bank' AND actor_id = $2`, [fx.tenantId, fx.user('admin').id])).rows[0].count;
    expect(Number(logged)).toBe(1);
  });

  it('keeps people out of profiles beyond their reach', async () => {
    expect((await api.call('GET', `/users/${fx.user('lc1').id}/profile`, t.admin2!)).statusCode).toBe(404);
    expect((await api.call('GET', `/users/${fx.user('lc1').id}/profile`, t.lc2!)).statusCode).toBe(403);
    expect((await api.call('GET', `/users/${fx.user('lc1').id}/profile?reveal=true`, t.lc2!)).statusCode).toBe(403);
    expect((await api.call('PUT', `/users/${fx.user('lc1').id}/profile`, t.lc2!, { address: 'x' })).statusCode).toBe(403);
    expect((await api.call('PUT', `/users/${fx.user('lc1').id}/profile`, t.admin!, { address: 'x' })).statusCode).toBe(403); // reading is not managing
    expect((await api.call('GET', `/users/0197f000-0000-7000-8000-000000000000/profile`, t.sa!)).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v1/me/profile' })).statusCode).toBe(401);
  });

  it('does not show the full number to an Admin who cannot enter salaries', async () => {
    await owner.query(`DELETE FROM role_permissions WHERE tenant_id = $1 AND role_id = $2 AND permission_id = (SELECT id FROM permissions WHERE code = 'salary.write')`, [fx.tenantId, fx.roleId('admin')]);
    const token = await api.signIn('admin', { office: true });
    expect((await api.call('GET', `/users/${fx.user('lc1').id}/profile?reveal=true`, token)).statusCode).toBe(403);
    expect((await api.call('GET', `/users/${fx.user('lc1').id}/profile`, token)).json().bankAccountNo).toBe('********9012');
  });
});
