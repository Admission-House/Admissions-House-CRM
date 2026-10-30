import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { TokenService } from '../src/auth/token.service.js';
import { loadEnv } from '../src/config/env.js';
import { startApp } from './helpers/app.js';
import { createFixture, Fixture, OFFICE, OFFICE_IP, OUTSIDE_IP, PASSWORD } from './helpers/fixtures.js';

let app: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;

const REFRESH_COOKIE = 'ah_rt';

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  app = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '200' });
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.end();
});

// ------------------------------------------------------------------ helpers

type Body = Record<string, unknown>;

const login = (body: Body, ip = OUTSIDE_IP, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: body, remoteAddress: ip, headers });

const credentials = (name: string, password = PASSWORD) => ({
  tenant: fx.slug,
  email: fx.user(name).email,
  password,
});

const inOffice = { lat: OFFICE.lat, lng: OFFICE.lng, accuracy: 20 };

/** Signs a user in and returns the pieces the tests need. */
async function signIn(name: string, extra: Body = {}, ip = OUTSIDE_IP) {
  const res = await login({ ...credentials(name), ...extra }, ip);
  expect(res.statusCode, `sign-in of ${name}: ${res.body}`).toBe(200);
  const cookie = res.cookies.find((c) => c.name === REFRESH_COOKIE);
  return {
    res,
    token: res.json().accessToken as string,
    refreshCookie: cookie?.value,
    refreshBody: res.json().refreshToken as string | undefined,
  };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const get = (url: string, token: string, ip = OUTSIDE_IP) =>
  app.inject({ method: 'GET', url, headers: bearer(token), remoteAddress: ip });
const refreshWithCookie = (value: string) =>
  app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: {}, headers: { cookie: `${REFRESH_COOKIE}=${value}` } });

const sessionOf = async (userName: string) =>
  (await owner.query(`SELECT * FROM user_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [fx.user(userName).id])).rows[0];

// ------------------------------------------------------------------ sign in

describe('sign in', () => {
  it('lets a Super Admin in from anywhere and keeps the refresh token out of reach of scripts', async () => {
    const { res } = await signIn('super');
    const body = res.json();
    expect(body).toMatchObject({ expiresIn: 900, mustChangePassword: false, user: { role: { key: 'super_admin' } } });
    expect(body.refreshToken).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/argon2|password_hash/);
    expect(res.headers['cache-control']).toBe('no-store');

    const cookie = res.cookies.find((c) => c.name === REFRESH_COOKIE)!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/api/v1/auth' });
    expect(cookie.value).toMatch(/^v1\./);
  });

  it('gives the same answer for a wrong password, an unknown email and an unknown company', async () => {
    const wrongPassword = await login(credentials('super', 'Wrong-password-1'));
    const unknownEmail = await login({ ...credentials('super'), email: 'nobody@test.example' });
    const unknownCompany = await login({ ...credentials('super'), tenant: 'no-such-company' });

    for (const res of [wrongPassword, unknownEmail, unknownCompany]) {
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toMatchObject({ code: 'INVALID_CREDENTIALS', message: 'The email or password is not correct' });
    }
  });

  it('does not tell a guesser the account is locked, but tells the owner who knows the password', async () => {
    const attemptsBefore = async () =>
      Number((await owner.query(`SELECT count(*) FROM login_attempts WHERE user_id = $1`, [fx.user('lockme').id])).rows[0].count);

    for (let i = 0; i < 5; i++) {
      expect((await login(credentials('lockme', 'Wrong-password-1'))).statusCode).toBe(401);
    }
    const locked = await login(credentials('lockme'));
    expect(locked.statusCode).toBe(423);
    expect(locked.json().error.code).toBe('ACCOUNT_LOCKED');

    const guess = await login(credentials('lockme', 'Another-wrong-1'));
    expect(guess.statusCode).toBe(401);
    expect(guess.json().error.code).toBe('INVALID_CREDENTIALS');
    expect(await attemptsBefore()).toBeGreaterThanOrEqual(7);

    // When the lock runs out the right password works again and the counter starts over.
    await owner.query(`UPDATE users SET locked_until = now() - interval '1 minute' WHERE id = $1`, [fx.user('lockme').id]);
    expect((await login(credentials('lockme'))).statusCode).toBe(200);
    const row = (await owner.query(`SELECT failed_logins, locked_until FROM users WHERE id = $1`, [fx.user('lockme').id])).rows[0];
    expect(row).toMatchObject({ failed_logins: 0, locked_until: null });
  });

  it('refuses an inactive account, but only after the password is proven', async () => {
    const right = await login(credentials('inactive'));
    expect(right.statusCode).toBe(403);
    expect(right.json().error.code).toBe('ACCOUNT_INACTIVE');
    const wrong = await login(credentials('inactive', 'Wrong-password-1'));
    expect(wrong.json().error.code).toBe('INVALID_CREDENTIALS');
  });

  it('rejects a malformed request with field errors', async () => {
    const res = await login({ tenant: 'x', email: 'not-an-email', password: '' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
    expect(res.json().error.fieldErrors.map((f: { field: string }) => f.field).sort()).toEqual(['email', 'password', 'tenant']);
  });

  it('flags an account that must choose a new password', async () => {
    const { res } = await signIn('mustchange');
    expect(res.json().mustChangePassword).toBe(true);
  });
});

describe('the office check (Admin and Counsellor only)', () => {
  const attempt = (extra: Body, ip = OFFICE_IP, headers: Record<string, string> = {}) =>
    login({ ...credentials('counsellor'), ...extra }, ip, headers);
  const refused = (res: { statusCode: number; json: () => { error: { code: string } } }) => {
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('OUTSIDE_OFFICE');
  };

  it('accepts the office network with a position inside the radius', async () => {
    expect((await attempt({ location: inOffice })).statusCode).toBe(200);
    expect((await login({ ...credentials('admin'), location: inOffice }, OFFICE_IP)).statusCode).toBe(200);
  });

  it('refuses the right position from the wrong network', async () => {
    refused(await attempt({ location: inOffice }, OUTSIDE_IP));
  });

  it('refuses the right network without a position', async () => {
    refused(await attempt({}));
  });

  it('refuses the right network with a position far away', async () => {
    refused(await attempt({ location: { lat: OFFICE.lat + 0.05, lng: OFFICE.lng, accuracy: 20 } }));
  });

  it('refuses a vague or mocked position', async () => {
    refused(await attempt({ location: { ...inOffice, accuracy: 500 } }));
    refused(await attempt({ location: { ...inOffice, mocked: true } }));
  });

  it('ignores a forged X-Forwarded-For when no proxy is configured', async () => {
    refused(await attempt({ location: inOffice }, OUTSIDE_IP, { 'x-forwarded-for': OFFICE_IP }));
  });

  it('records refused attempts', async () => {
    const { rows } = await owner.query(
      `SELECT count(*)::int AS n FROM login_attempts WHERE user_id = $1 AND result = 'outside_office'`,
      [fx.user('counsellor').id],
    );
    expect(rows[0].n).toBeGreaterThanOrEqual(5);
  });

  it('refuses everyone when the office has no position or network set up', async () => {
    await owner.query(`UPDATE branches SET latitude = NULL, longitude = NULL WHERE id = $1`, [fx.branchId]);
    try {
      refused(await attempt({ location: inOffice }));
    } finally {
      await owner.query(`UPDATE branches SET latitude = $2, longitude = $3 WHERE id = $1`, [fx.branchId, OFFICE.lat, OFFICE.lng]);
    }
  });
});

describe('mobile app sign-in', () => {
  const device = { fingerprint: 'device-fingerprint-0001', platform: 'android', label: 'Test phone' };
  const mobile = (extra: Body = {}) =>
    login({ ...credentials('mobile'), clientType: 'mobile', location: inOffice, ...extra }, OFFICE_IP);

  it('needs the phone to identify itself', async () => {
    const res = await mobile();
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('DEVICE_REQUIRED');
  });

  it('holds a new phone until an Admin approves it, then lets it in with the refresh token in the body', async () => {
    const waiting = await mobile({ device });
    expect(waiting.statusCode).toBe(403);
    expect(waiting.json().error.code).toBe('DEVICE_NOT_APPROVED');

    await owner.query(
      `UPDATE user_devices SET approved_by = $2, approved_at = now() WHERE user_id = $1 AND device_fingerprint = $3`,
      [fx.user('mobile').id, fx.user('admin').id, device.fingerprint],
    );
    const res = await mobile({ device });
    expect(res.statusCode).toBe(200);
    expect(res.json().refreshToken).toMatch(/^v1\./);
    expect(res.cookies.find((c) => c.name === REFRESH_COOKIE)).toBeUndefined();

    const rotated = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: res.json().refreshToken } });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().refreshToken).toMatch(/^v1\./);
    expect(rotated.json().refreshToken).not.toBe(res.json().refreshToken);
  });
});

// ------------------------------------------------------------------ the guard

describe('the guard on protected routes', () => {
  it('refuses a request with no token, a malformed header or a forged token', async () => {
    const none = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(none.statusCode).toBe(401);
    expect(none.json().error.code).toBe('UNAUTHENTICATED');

    const malformed = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: 'Bearer garbage' } });
    expect(malformed.statusCode).toBe(401);

    const forged = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: 'Bearer aaa.bbb.ccc' } });
    expect(forged.statusCode).toBe(401);
    expect(forged.json().error.code).toBe('TOKEN_INVALID');
  });

  it('keeps public routes open', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/health/live' })).statusCode).toBe(200);
  });

  it('returns the signed-in user, permissions and company', async () => {
    const { token } = await signIn('super');
    const res = await get('/api/v1/auth/me', token);
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ email: fx.user('super').email, role: { key: 'super_admin', dataScope: 'all' } });
    expect(res.json().permissions.length).toBeGreaterThan(40);
    expect(res.json().company.name).toMatch(/^Test /);
  });

  it('enforces the permission a route asks for', async () => {
    const counsellor = (await signIn('counsellor', { location: inOffice }, OFFICE_IP)).token;
    expect((await get('/api/v1/test/leads', counsellor, OFFICE_IP)).statusCode).toBe(200);
    const denied = await get('/api/v1/test/users', counsellor, OFFICE_IP);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('FORBIDDEN');

    const { token: superToken } = await signIn('super');
    expect((await get('/api/v1/test/users', superToken)).statusCode).toBe(200);
  });

  it('lets an account that must change its password do nothing else', async () => {
    const { token } = await signIn('mustchange');
    const blocked = await get('/api/v1/test/leads', token);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await get('/api/v1/auth/me', token)).statusCode).toBe(200);
  });

  it('applies a change of role permissions on the very next request', async () => {
    const roleId = (
      await owner.query(
        `INSERT INTO roles (tenant_id, name, data_scope, requires_office) VALUES ($1, 'temp-role', 'own', false) RETURNING id`,
        [fx.tenantId],
      )
    ).rows[0].id;
    await owner.query(
      `INSERT INTO role_permissions (tenant_id, role_id, permission_id) SELECT $1, $2, id FROM permissions WHERE code = 'lead.read'`,
      [fx.tenantId, roleId],
    );
    await owner.query(`UPDATE users SET role_id = $2, branch_id = NULL WHERE id = $1`, [fx.user('perms').id, roleId]);

    const { token } = await signIn('perms');
    expect((await get('/api/v1/test/leads', token)).statusCode).toBe(200);
    await owner.query(`DELETE FROM role_permissions WHERE role_id = $1`, [roleId]);
    expect((await get('/api/v1/test/leads', token)).statusCode).toBe(403);
  });

  it('rejects a genuine token whose company does not match the session (cross-company use)', async () => {
    const { token } = await signIn('super');
    const claims = await new TokenService(loadEnv(process.env)).verifyAccess(token);
    const wrongCompany = await new TokenService(loadEnv(process.env)).signAccess({ ...claims, tenantId: randomUUID() });
    const res = await get('/api/v1/auth/me', wrongCompany.token);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('SESSION_INVALID');
  });
});

describe('session lifetime', () => {
  it('signing out ends the session at once', async () => {
    const { token } = await signIn('logout');
    const out = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: bearer(token) });
    expect(out.statusCode).toBe(204);
    const after = await get('/api/v1/auth/me', token);
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe('SESSION_ENDED');
    expect((await sessionOf('logout')).ended_reason).toBe('logout');
  });

  it('signs out after 30 minutes of inactivity, and counts a request as activity', async () => {
    const { token } = await signIn('idle');
    await owner.query(`UPDATE user_sessions SET last_active_at = now() - interval '10 minutes' WHERE user_id = $1`, [fx.user('idle').id]);
    expect((await get('/api/v1/auth/me', token)).statusCode).toBe(200);
    const touched = await sessionOf('idle');
    expect(Date.now() - new Date(touched.last_active_at).getTime()).toBeLessThan(60_000);

    await owner.query(`UPDATE user_sessions SET last_active_at = now() - interval '31 minutes' WHERE user_id = $1`, [fx.user('idle').id]);
    const res = await get('/api/v1/auth/me', token);
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatchObject({ code: 'SESSION_IDLE', message: expect.stringContaining('30 minutes') });
    expect((await sessionOf('idle')).ended_reason).toBe('inactivity');
  });

  it('ends a session that has reached its maximum age', async () => {
    const { token } = await signIn('expired');
    await owner.query(`UPDATE user_sessions SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [fx.user('expired').id]);
    const res = await get('/api/v1/auth/me', token);
    expect(res.json().error.code).toBe('SESSION_EXPIRED');
    expect((await sessionOf('expired')).ended_reason).toBe('expired');
  });

  it('stops a deactivated user on the next request', async () => {
    const { token } = await signIn('deactivate');
    await owner.query(`UPDATE users SET status = 'inactive' WHERE id = $1`, [fx.user('deactivate').id]);
    const res = await get('/api/v1/auth/me', token);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('ACCOUNT_INACTIVE');
    expect((await sessionOf('deactivate')).ended_reason).toBe('revoked');
  });
});

// ------------------------------------------------------------------ refresh

describe('refresh tokens', () => {
  it('rotates on every use', async () => {
    const { refreshCookie, token } = await signIn('refresh');
    const res = await refreshWithCookie(refreshCookie!);
    expect(res.statusCode).toBe(200);
    expect(res.json().accessToken).toEqual(expect.any(String));
    const next = res.cookies.find((c) => c.name === REFRESH_COOKIE)!;
    expect(next.value).not.toBe(refreshCookie);
    expect((await get('/api/v1/auth/me', res.json().accessToken)).statusCode).toBe(200);
    expect((await get('/api/v1/auth/me', token)).statusCode).toBe(200);
  });

  it('ends the whole session when an old token is used again', async () => {
    const { refreshCookie: first, token } = await signIn('reuse');
    const second = (await refreshWithCookie(first!)).cookies.find((c) => c.name === REFRESH_COOKIE)!.value;

    const replay = await refreshWithCookie(first!);
    expect(replay.statusCode).toBe(401);
    expect((await sessionOf('reuse')).ended_reason).toBe('reuse_detected');

    // The legitimate holder of the newest token is signed out too: they cannot be told apart.
    expect((await refreshWithCookie(second)).statusCode).toBe(401);
    expect((await get('/api/v1/auth/me', token)).json().error.code).toBe('SESSION_ENDED');

    const audit = await owner.query(`SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND action = 'auth.refresh_token_reuse'`, [fx.tenantId]);
    expect(audit.rows[0].n).toBe(1);
  });

  it('lets exactly one of two simultaneous refreshes through', async () => {
    const { refreshCookie } = await signIn('race');
    const results = await Promise.all([refreshWithCookie(refreshCookie!), refreshWithCookie(refreshCookie!)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
  });

  it.each([
    ['nothing', undefined],
    ['garbage', 'not-a-token'],
    ['a well-formed token that was never issued', `v1.${randomUUID()}.${randomUUID()}.${'a'.repeat(43)}`],
  ])('refuses %s', async (_name, value) => {
    const res = value === undefined
      ? await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: {} })
      : await refreshWithCookie(value);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('TOKEN_INVALID');
  });

  it('refuses to refresh a session that has been idle too long', async () => {
    const { refreshCookie } = await signIn('idle');
    await owner.query(`UPDATE user_sessions SET last_active_at = now() - interval '31 minutes' WHERE user_id = $1 AND ended_at IS NULL`, [fx.user('idle').id]);
    const res = await refreshWithCookie(refreshCookie!);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('SESSION_IDLE');
  });
});

// ------------------------------------------------------------------ password

describe('changing the password', () => {
  const change = (token: string, body: Body) =>
    app.inject({ method: 'POST', url: '/api/v1/auth/change-password', headers: bearer(token), payload: body });

  it('refuses the wrong current password', async () => {
    const { token } = await signIn('pwchange');
    const res = await change(token, { currentPassword: 'Wrong-password-1', newPassword: 'Brand-new-pass-77' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CURRENT_PASSWORD_WRONG');
  });

  it('refuses a weak, reused or email-based password', async () => {
    const { token } = await signIn('pwchange');
    const weak = await change(token, { currentPassword: PASSWORD, newPassword: 'short1' });
    expect(weak.json().error).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(weak.json().error.fieldErrors[0].field).toBe('newPassword');

    const same = await change(token, { currentPassword: PASSWORD, newPassword: PASSWORD });
    expect(same.json().error.code).toBe('PASSWORD_REJECTED');

    const local = fx.user('pwchange').email.split('@')[0];
    const fromEmail = await change(token, { currentPassword: PASSWORD, newPassword: `${local}-2026` });
    expect(fromEmail.json().error.code).toBe('PASSWORD_REJECTED');
  });

  it('changes it, ends the other sessions and clears the must-change flag', async () => {
    const first = await signIn('pwchange');
    const other = await signIn('pwchange');
    const res = await change(first.token, { currentPassword: PASSWORD, newPassword: 'Brand-new-pass-77' });
    expect(res.statusCode).toBe(200);
    expect(res.json().otherSessionsEnded).toBeGreaterThanOrEqual(1);

    expect((await get('/api/v1/auth/me', other.token)).json().error.code).toBe('SESSION_ENDED');
    expect((await get('/api/v1/auth/me', first.token)).statusCode).toBe(200);
    expect((await login(credentials('pwchange'))).statusCode).toBe(401);
    expect((await login(credentials('pwchange', 'Brand-new-pass-77'))).statusCode).toBe(200);
  });

  it('frees an account that had to change it', async () => {
    const { token } = await signIn('mustchange');
    expect((await change(token, { currentPassword: PASSWORD, newPassword: 'Fresh-choice-2026' })).statusCode).toBe(200);
    expect((await get('/api/v1/test/leads', token)).statusCode).toBe(200);
    expect((await login(credentials('mustchange', 'Fresh-choice-2026'))).json().mustChangePassword).toBe(false);
  });
});

// ------------------------------------------------------------------ sessions

describe('own sessions', () => {
  it('lists them and lets the person end another one', async () => {
    const a = await signIn('sessions');
    const b = await signIn('sessions');
    const list = await get('/api/v1/auth/sessions', a.token);
    expect(list.statusCode).toBe(200);
    expect(list.json().length).toBeGreaterThanOrEqual(2);
    expect(list.json().filter((s: { current: boolean }) => s.current)).toHaveLength(1);

    const bId = (await owner.query(`SELECT id FROM user_sessions WHERE refresh_token_hash IS NOT NULL AND user_id = $1 AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1`, [fx.user('sessions').id])).rows[0].id;
    const revoke = await app.inject({ method: 'DELETE', url: `/api/v1/auth/sessions/${bId}`, headers: bearer(a.token) });
    expect(revoke.statusCode).toBe(204);
    expect((await get('/api/v1/auth/me', b.token)).statusCode).toBe(401);
  });

  it('does not let a person end their current session this way, or anyone else\'s', async () => {
    // A counsellor (not someone who manages users): their own current session and other people's are off limits.
    const mine = await signIn('victim', { location: inOffice }, OFFICE_IP);
    const theirs = await signIn('super');
    const theirId = (await sessionOf('super')).id as string;
    const myId = (await sessionOf('victim')).id as string;

    const self = await app.inject({ method: 'DELETE', url: `/api/v1/auth/sessions/${myId}`, headers: bearer(mine.token) });
    expect(self.json().error.code).toBe('USE_LOGOUT');

    const other = await app.inject({ method: 'DELETE', url: `/api/v1/auth/sessions/${theirId}`, headers: bearer(mine.token) });
    expect(other.statusCode).toBe(404);
    expect((await get('/api/v1/auth/me', theirs.token)).statusCode).toBe(200);

    const notAnId = await app.inject({ method: 'DELETE', url: '/api/v1/auth/sessions/not-a-uuid', headers: bearer(mine.token) });
    expect(notAnId.statusCode).toBe(400);
  });
});

describe('sessions managed by a Super Admin', () => {
  it('lists every active session and can end one, which is audited', async () => {
    const sa = await signIn('super');
    const victim = await signIn('sessions');
    const victimSession = (await sessionOf('sessions')).id as string;

    const all = await get('/api/v1/auth/sessions/all', sa.token);
    expect(all.statusCode).toBe(200);
    expect(all.json().some((s: { id: string; user: { name: string } }) => s.id === victimSession && s.user.name === 'sessions')).toBe(true);
    const filtered = await get(`/api/v1/auth/sessions/all?userId=${fx.user('sessions').id}`, sa.token);
    expect(filtered.json().every((s: { user: { id: string } }) => s.user.id === fx.user('sessions').id)).toBe(true);

    const end = await app.inject({ method: 'DELETE', url: `/api/v1/auth/sessions/${victimSession}`, headers: bearer(sa.token) });
    expect(end.statusCode).toBe(204);
    expect((await get('/api/v1/auth/me', victim.token)).statusCode).toBe(401);
    const logged = await owner.query(`SELECT actor_id FROM audit_logs WHERE tenant_id = $1 AND action = 'auth.session_revoked_by_admin' AND entity_id = $2`, [fx.tenantId, victimSession]);
    expect(logged.rows[0].actor_id).toBe(fx.user('super').id);
  });

  it('is closed to everyone else', async () => {
    const lc = await signIn('victim', { location: inOffice }, OFFICE_IP);
    expect((await get('/api/v1/auth/sessions/all', lc.token)).statusCode).toBe(403);
  });
});

// ------------------------------------------------------------------ throttling

describe('repeated attempts from one address', () => {
  it('are slowed down with a 429 and a Retry-After header', async () => {
    const strict = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '5' });
    try {
      const ip = '198.51.100.9';
      for (let i = 0; i < 5; i++) {
        const res = await strict.inject({ method: 'POST', url: '/api/v1/auth/login', payload: credentials('throttle', 'Wrong-password-1'), remoteAddress: ip });
        expect(res.statusCode).toBe(401);
      }
      const blocked = await strict.inject({ method: 'POST', url: '/api/v1/auth/login', payload: credentials('throttle'), remoteAddress: ip });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error.code).toBe('TOO_MANY_ATTEMPTS');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      await strict.close();
    }
  });
});
