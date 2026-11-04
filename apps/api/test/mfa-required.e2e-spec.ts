import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { base32Decode, hotp, stepOf } from '../src/auth/totp.js';
import { startApp } from './helpers/app.js';
import { Client, makeClient } from './helpers/client.js';
import { createFixture, Fixture, PASSWORD } from './helpers/fixtures.js';

let app: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;
let api: Client;

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  app = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500' });
  api = makeClient(app, fx);
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.end();
});

const idOf = (name: string) => fx.user(name).id;
const codeFor = (secret: string, steps = 0) => hotp(base32Decode(secret), stepOf(Date.now()) + steps);
const errorCode = (res: { json: () => { error?: { code?: string } } }) => res.json().error?.code;
const setPolicy = (token: string, requireTwoStep: string) => api.call('PUT', '/company/security', token, { requireTwoStep });
const policyInDb = async () => (await owner.query(`SELECT settings->>'require_two_step' AS p FROM tenants WHERE id = $1`, [fx.tenantId])).rows[0].p as string | null;
const allowReuse = (name: string) => owner.query(`UPDATE user_mfa SET last_step = NULL WHERE user_id = $1`, [idOf(name)]);
const auditCount = async () => Number((await owner.query(`SELECT count(*) AS n FROM audit_logs WHERE tenant_id = $1 AND action = 'company.security_change'`, [fx.tenantId])).rows[0].n);

/** What the person does when the CRM asks them to set it up: password, scan, first code. */
async function setUp(token: string) {
  const setup = await api.call('POST', '/auth/mfa/setup', token, { password: PASSWORD });
  expect(setup.statusCode, setup.body).toBe(200);
  const secret = setup.json().secret as string;
  const enable = await api.call('POST', '/auth/mfa/enable', token, { code: codeFor(secret) });
  expect(enable.statusCode, enable.body).toBe(200);
  return secret;
}

/** A Super Admin who has set up their own, and then makes the rule. Others are held by it; this one is not. */
async function makeRule(policy: string, actor = 'super') {
  const token = await api.signIn(actor);
  const secret = await setUp(token);
  const res = await setPolicy(token, policy);
  expect(res.statusCode, res.body).toBe(200);
  return { token, secret };
}

afterEach(async () => {
  // Every test starts with nobody required, and without anyone's two-step on.
  await owner.query(`UPDATE tenants SET settings = settings - 'require_two_step' WHERE id = $1`, [fx.tenantId]);
  await owner.query(`DELETE FROM user_recovery_codes WHERE tenant_id = $1`, [fx.tenantId]);
  await owner.query(`DELETE FROM user_mfa WHERE tenant_id = $1`, [fx.tenantId]);
  await owner.query(`UPDATE users SET locked_until = NULL, failed_logins = 0 WHERE tenant_id = $1`, [fx.tenantId]);
});

describe('the company setting', () => {
  it('starts as "nobody", is read and changed by someone who manages settings, and is audited', async () => {
    const { token } = await makeRule('admins');
    expect(await policyInDb()).toBe('admins');
    expect((await api.call('GET', '/company/security', token)).json()).toEqual({ requireTwoStep: 'admins' });

    const audit = (await owner.query(`SELECT before, after FROM audit_logs WHERE tenant_id = $1 AND action = 'company.security_change' ORDER BY id DESC LIMIT 1`, [fx.tenantId])).rows[0];
    expect(audit.before).toEqual({ requireTwoStep: 'none' });
    expect(audit.after).toEqual({ requireTwoStep: 'admins' });

    // Before anything is set it reads as "nobody".
    await owner.query(`UPDATE tenants SET settings = settings - 'require_two_step' WHERE id = $1`, [fx.tenantId]);
    expect((await api.call('GET', '/company/security', token)).json()).toEqual({ requireTwoStep: 'none' });
  });

  it('refuses a value that is not one of the three, and a person who may not manage settings', async () => {
    const boss = await api.signIn('super');
    expect((await setPolicy(boss, 'everyone')).statusCode).toBe(400);
    expect(await policyInDb()).toBeNull();

    const counsellor = await api.signIn('counsellor', { office: true });
    expect((await setPolicy(counsellor, 'admins')).statusCode).toBe(403);
    expect((await api.call('GET', '/company/security', counsellor)).statusCode).toBe(403);
  });

  it('will not make a rule that covers you before you have set up your own, so you are not locked out in the middle', async () => {
    const boss = await api.signIn('super');
    const res = await setPolicy(boss, 'super_admin');
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('SET_UP_YOUR_OWN_FIRST');
    expect(await policyInDb()).toBeNull();
    // A rule that does not cover you is fine.
    expect((await setPolicy(boss, 'none')).statusCode).toBe(200);
  });

  it('does not write an audit entry when nothing changed', async () => {
    const boss = await api.signIn('super');
    const before = await auditCount();
    await setPolicy(boss, 'none');
    expect(await auditCount()).toBe(before);
  });
});

describe('a person the company requires to use it', () => {
  it('can sign in but can do nothing except set it up, ask who they are and sign out', async () => {
    const held = await api.signIn('idle');
    await makeRule('super_admin');

    const refused = await api.call('GET', '/leads', held);
    expect(refused.statusCode).toBe(403);
    expect(errorCode(refused)).toBe('MFA_SETUP_REQUIRED');
    expect((await api.call('GET', '/dashboard', held)).statusCode).toBe(403);
    expect((await api.call('GET', '/company/security', held)).statusCode).toBe(403);

    const me = await api.call('GET', '/auth/me', held);
    expect(me.statusCode).toBe(200);
    expect(me.json().user.mfaSetupRequired).toBe(true);
    expect((await api.call('GET', '/auth/mfa', held)).statusCode).toBe(200);
    expect((await api.call('GET', '/company/logo', held)).statusCode).not.toBe(403);
  });

  it('is let through as soon as it is set up, and is not asked again', async () => {
    const held = await api.signIn('idle');
    await makeRule('super_admin');
    expect((await api.call('GET', '/leads', held)).statusCode).toBe(403);

    await setUp(held);
    expect((await api.call('GET', '/leads', held)).statusCode).toBe(200);
    expect((await api.call('GET', '/auth/me', held)).json().user.mfaSetupRequired).toBe(false);
  });

  it('can sign out while held', async () => {
    const held = await api.signIn('logout');
    await makeRule('super_admin');
    expect((await api.call('POST', '/auth/logout', held)).statusCode).toBe(204);
  });

  it('is asked for the code at the next sign-in like anyone, and is let in with it', async () => {
    const held = await api.signIn('idle');
    await makeRule('super_admin');
    const secret = await setUp(held);
    await allowReuse('idle');

    expect(errorCode(await api.login(api.credentials('idle')))).toBe('MFA_REQUIRED');
    const signedIn = await api.login({ ...api.credentials('idle'), mfaCode: codeFor(secret) });
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    expect((await api.call('GET', '/leads', signedIn.json().accessToken as string)).statusCode).toBe(200);
  });

  it('covers Admins only when the setting says "Super Admins and Admins", and never counsellors', async () => {
    const admin = await api.signIn('admin', { office: true });
    const counsellor = await api.signIn('counsellor', { office: true });

    const { token } = await makeRule('super_admin');
    expect((await api.call('GET', '/leads', admin)).statusCode).toBe(200);

    expect((await setPolicy(token, 'admins')).statusCode).toBe(200);
    const held = await api.call('GET', '/leads', admin);
    expect(held.statusCode).toBe(403);
    expect(errorCode(held)).toBe('MFA_SETUP_REQUIRED');
    expect((await api.call('GET', '/leads', counsellor)).statusCode).toBe(200);
  });

  it('is released when the company stops requiring it', async () => {
    const held = await api.signIn('idle');
    const { token } = await makeRule('super_admin');
    expect((await api.call('GET', '/leads', held)).statusCode).toBe(403);
    // Someone who is held cannot change the setting; the one who set up theirs can.
    expect((await setPolicy(held, 'none')).statusCode).toBe(403);
    expect((await setPolicy(token, 'none')).statusCode).toBe(200);
    expect((await api.call('GET', '/leads', held)).statusCode).toBe(200);
  });

  it('cannot turn it off while the company requires it, and can when it does not', async () => {
    const { token, secret } = await makeRule('super_admin');
    await allowReuse('super');

    const refused = await api.call('POST', '/auth/mfa/disable', token, { password: PASSWORD, code: codeFor(secret) });
    expect(refused.statusCode).toBe(409);
    expect(errorCode(refused)).toBe('MFA_REQUIRED_BY_POLICY');
    expect((await api.call('GET', '/auth/mfa', token)).json().enabled).toBe(true);

    expect((await setPolicy(token, 'none')).statusCode).toBe(200);
    const off = await api.call('POST', '/auth/mfa/disable', token, { password: PASSWORD, code: codeFor(secret, 1) });
    expect(off.statusCode, off.body).toBe(200);
  });

  it('is asked to set it up again after an administrator resets it', async () => {
    const lost = await api.signIn('refresh');
    const { token } = await makeRule('super_admin');
    await setUp(lost);
    expect((await api.call('GET', '/leads', lost)).statusCode).toBe(200);

    expect((await api.call('POST', `/users/${idOf('refresh')}/mfa/reset`, token)).json()).toEqual({ reset: true });
    // Signed in already, but now held until they set it up again.
    expect(errorCode(await api.call('GET', '/leads', lost))).toBe('MFA_SETUP_REQUIRED');
    await setUp(lost);
    expect((await api.call('GET', '/leads', lost)).statusCode).toBe(200);
  });
});
