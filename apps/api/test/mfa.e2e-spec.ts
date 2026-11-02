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

// ------------------------------------------------------------------ helpers

const errorCode = (res: { json: () => { error?: { code?: string } } }) => res.json().error?.code;
const idOf = (name: string) => fx.user(name).id;
/** The code an authenticator app shows for this secret, `steps` 30-second steps from now. */
const codeFor = (secret: string, steps = 0) => hotp(base32Decode(secret), stepOf(Date.now()) + steps);
/** Forgets the last used code, so a test that signs in again is not stopped by the one-use rule. */
const allowReuse = (name: string) => owner.query(`UPDATE user_mfa SET last_step = NULL WHERE user_id = $1`, [idOf(name)]);
const signInWith = (name: string, extra: Record<string, unknown> = {}, password = PASSWORD) => api.login({ ...api.credentials(name, password), ...extra });
const unlock = (name: string) => owner.query(`UPDATE users SET locked_until = NULL, failed_logins = 0 WHERE id = $1`, [idOf(name)]);
const auditActions = async (name: string) =>
  (await owner.query(`SELECT action FROM audit_logs WHERE tenant_id = $1 AND entity_id = $2 ORDER BY id`, [fx.tenantId, idOf(name)])).rows.map((r) => r.action as string);

/** Turns two-step sign-in on for a user, the way a person would, and returns what they would hold. */
async function enrol(name: string) {
  const token = await api.signIn(name);
  const setup = await api.call('POST', '/auth/mfa/setup', token, { password: PASSWORD });
  expect(setup.statusCode, setup.body).toBe(200);
  const secret = setup.json().secret as string;
  const enable = await api.call('POST', '/auth/mfa/enable', token, { code: codeFor(secret) });
  expect(enable.statusCode, enable.body).toBe(200);
  return { token, secret, recoveryCodes: enable.json().recoveryCodes as string[] };
}

// ------------------------------------------------------------------ setting it up

describe('turning two-step sign-in on', () => {
  it('is off by default and does not change sign-in until it is confirmed', async () => {
    const token = await api.signIn('super');
    expect((await api.call('GET', '/auth/mfa', token)).json()).toEqual({ enabled: false, setupStarted: false, recoveryCodesLeft: 0 });

    const setup = await api.call('POST', '/auth/mfa/setup', token, { password: PASSWORD });
    expect(setup.statusCode).toBe(200);
    expect(setup.json().secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.json().otpauthUrl).toContain(`secret=${setup.json().secret}`);
    expect(setup.json().otpauthUrl).toContain(encodeURIComponent(fx.user('super').email));
    expect((await api.call('GET', '/auth/mfa', token)).json()).toMatchObject({ enabled: false, setupStarted: true });

    // A half-finished set-up asks for nothing at sign-in.
    expect((await signInWith('super')).statusCode).toBe(200);
  });

  it('needs the password to start, and counts a wrong one like a failed sign-in', async () => {
    const token = await api.signIn('lockme');
    for (let i = 0; i < 5; i++) {
      const res = await api.call('POST', '/auth/mfa/setup', token, { password: 'Wrong-password-1' });
      expect(res.statusCode).toBe(403);
      expect(errorCode(res)).toBe('CURRENT_PASSWORD_WRONG');
    }
    const failures = (await owner.query(`SELECT failed_logins, locked_until FROM users WHERE id = $1`, [idOf('lockme')])).rows[0];
    expect(failures.failed_logins).toBeGreaterThanOrEqual(5);
    expect(failures.locked_until).not.toBeNull();
    await unlock('lockme');
  });

  it('refuses a wrong first code, then turns on with the right one and gives eight recovery codes, once', async () => {
    const token = await api.signIn('idle');
    const secret = (await api.call('POST', '/auth/mfa/setup', token, { password: PASSWORD })).json().secret as string;

    const wrong = await api.call('POST', '/auth/mfa/enable', token, { code: codeFor(secret, 5) });
    expect(wrong.statusCode).toBe(400);
    expect(errorCode(wrong)).toBe('MFA_CODE_WRONG');

    const ok = await api.call('POST', '/auth/mfa/enable', token, { code: codeFor(secret) });
    expect(ok.statusCode, ok.body).toBe(200);
    const codes = ok.json().recoveryCodes as string[];
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
    for (const c of codes) expect(c).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
    expect((await api.call('GET', '/auth/mfa', token)).json()).toEqual({ enabled: true, setupStarted: false, recoveryCodesLeft: 8 });

    expect((await api.call('POST', '/auth/mfa/setup', token, { password: PASSWORD })).statusCode).toBe(409);
    expect((await api.call('POST', '/auth/mfa/enable', token, { code: codeFor(secret) })).statusCode).toBe(409);
  });

  it('keeps the secret sealed and the recovery codes hashed in the database', async () => {
    const { secret, recoveryCodes } = await enrol('expired');
    const row = (await owner.query(`SELECT secret_sealed FROM user_mfa WHERE user_id = $1`, [idOf('expired')])).rows[0];
    expect(row.secret_sealed).toMatch(/^v1\./);
    expect(row.secret_sealed).not.toContain(secret);
    const stored = (await owner.query(`SELECT code_hash FROM user_recovery_codes WHERE user_id = $1`, [idOf('expired')])).rows.map((r) => r.code_hash as string);
    expect(stored).toHaveLength(8);
    for (const c of recoveryCodes) expect(stored).not.toContain(c);
    expect(await auditActions('expired')).toContain('auth.mfa_enabled');
  });
});

// ------------------------------------------------------------------ signing in

describe('signing in with two-step on', () => {
  let secret: string;
  let recoveryCodes: string[];

  beforeAll(async () => {
    ({ secret, recoveryCodes } = await enrol('refresh'));
  });

  it('asks for the code once the password is right, and gives nothing away before that', async () => {
    const missing = await signInWith('refresh');
    expect(missing.statusCode).toBe(401);
    expect(errorCode(missing)).toBe('MFA_REQUIRED');
    expect(missing.json().accessToken).toBeUndefined();

    const wrongPassword = await signInWith('refresh', {}, 'Wrong-password-1');
    expect(errorCode(wrongPassword)).toBe('INVALID_CREDENTIALS');
  });

  it('refuses a wrong code and logs it as a failed attempt', async () => {
    const res = await signInWith('refresh', { mfaCode: '000000' });
    expect(res.statusCode).toBe(401);
    expect(errorCode(res)).toBe('MFA_CODE_WRONG');
    const last = (await owner.query(`SELECT result FROM login_attempts WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [idOf('refresh')])).rows[0];
    expect(last.result).toBe('bad_code');
    await unlock('refresh');
  });

  it('lets the right code in, and refuses the same code a second time', async () => {
    await allowReuse('refresh');
    const code = codeFor(secret);
    const first = await signInWith('refresh', { mfaCode: code });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().accessToken).toBeTruthy();

    const again = await signInWith('refresh', { mfaCode: code });
    expect(again.statusCode).toBe(401);
    expect(errorCode(again)).toBe('MFA_CODE_WRONG');
    await unlock('refresh');
  });

  it('accepts a code from the step before or after, for a phone whose clock is a little off', async () => {
    await allowReuse('refresh');
    expect((await signInWith('refresh', { mfaCode: codeFor(secret, -1) })).statusCode).toBe(200);
    await allowReuse('refresh');
    expect((await signInWith('refresh', { mfaCode: codeFor(secret, 1) })).statusCode).toBe(200);
    await allowReuse('refresh');
    expect((await signInWith('refresh', { mfaCode: codeFor(secret, 3) })).statusCode).toBe(401);
    await unlock('refresh');
  });

  it('locks the account after repeated wrong codes, even for the right one', async () => {
    await allowReuse('refresh');
    for (let i = 0; i < 5; i++) expect((await signInWith('refresh', { mfaCode: String(100000 + i) })).statusCode).toBe(401);
    const locked = await signInWith('refresh', { mfaCode: codeFor(secret) });
    expect(locked.statusCode).toBe(423);
    expect(errorCode(locked)).toBe('ACCOUNT_LOCKED');
    await unlock('refresh');
  });

  it('lets a recovery code in once, records it, and counts what is left', async () => {
    const [first, second] = recoveryCodes as [string, string];
    const res = await signInWith('refresh', { mfaCode: first });
    expect(res.statusCode, res.body).toBe(200);

    const again = await signInWith('refresh', { mfaCode: first });
    expect(errorCode(again)).toBe('MFA_CODE_WRONG');
    await unlock('refresh');

    // Typed in capitals and without the dash, it is still the same code.
    const other = await signInWith('refresh', { mfaCode: second.toUpperCase().replace('-', ' ') });
    expect(other.statusCode, other.body).toBe(200);

    expect(await auditActions('refresh')).toContain('auth.mfa_recovery_used');
    const token = res.json().accessToken as string;
    expect((await api.call('GET', '/auth/mfa', token)).json().recoveryCodesLeft).toBe(6);
  });
});

// ------------------------------------------------------------------ turning it off

describe('turning two-step sign-in off', () => {
  it('needs the password and a current code, and then sign-in asks for no code', async () => {
    const { token, secret } = await enrol('deactivate');
    await allowReuse('deactivate');

    const noPassword = await api.call('POST', '/auth/mfa/disable', token, { password: 'Wrong-password-1', code: codeFor(secret, 1) });
    expect(noPassword.statusCode).toBe(403);
    await unlock('deactivate');

    const noCode = await api.call('POST', '/auth/mfa/disable', token, { password: PASSWORD, code: '000000' });
    expect(noCode.statusCode).toBe(403);
    expect(errorCode(noCode)).toBe('MFA_CODE_WRONG');
    expect((await api.call('GET', '/auth/mfa', token)).json().enabled).toBe(true);

    const off = await api.call('POST', '/auth/mfa/disable', token, { password: PASSWORD, code: codeFor(secret, 1) });
    expect(off.statusCode, off.body).toBe(200);
    expect((await api.call('GET', '/auth/mfa', token)).json()).toEqual({ enabled: false, setupStarted: false, recoveryCodesLeft: 0 });
    expect((await signInWith('deactivate')).statusCode).toBe(200);
    expect(await auditActions('deactivate')).toContain('auth.mfa_disabled');
  });
});

// ------------------------------------------------------------------ a lost phone

describe('a lost phone', () => {
  it('lets a Super Admin switch off someone else\'s two-step sign-in, and is written to the audit log', async () => {
    await enrol('race');
    const boss = await api.signIn('logout');
    expect(errorCode(await signInWith('race'))).toBe('MFA_REQUIRED');

    const res = await api.call('POST', `/users/${idOf('race')}/mfa/reset`, boss);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ reset: true });
    expect((await signInWith('race')).statusCode).toBe(200);
    expect(await auditActions('race')).toContain('auth.mfa_reset');

    // Nothing to reset the second time, and an unknown user is not found.
    expect((await api.call('POST', `/users/${idOf('race')}/mfa/reset`, boss)).json()).toEqual({ reset: false });
    expect((await api.call('POST', '/users/00000000-0000-4000-8000-000000000000/mfa/reset', boss)).statusCode).toBe(404);
  });

  it('is not allowed for a person without the right to manage users', async () => {
    const lowly = await api.signIn('counsellor', { office: true });
    const res = await api.call('POST', `/users/${idOf('super')}/mfa/reset`, lowly);
    expect(res.statusCode).toBe(403);
  });
});

it('needs a sign-in for every two-step route', async () => {
  for (const [method, url] of [['GET', '/auth/mfa'], ['POST', '/auth/mfa/setup'], ['POST', '/auth/mfa/enable'], ['POST', '/auth/mfa/disable']] as const) {
    const res = await app.inject({ method, url: `/api/v1${url}`, payload: method === 'POST' ? {} : undefined });
    expect(res.statusCode, `${method} ${url}`).toBe(401);
  }
  expect(stepOf(0)).toBe(0);
});
