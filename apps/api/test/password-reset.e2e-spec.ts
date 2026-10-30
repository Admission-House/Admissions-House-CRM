import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { MailerService } from '../src/mail/mailer.service.js';
import { startApp } from './helpers/app.js';
import { Client, makeClient } from './helpers/client.js';
import { createFixture, Fixture, PASSWORD } from './helpers/fixtures.js';

let app: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;
let api: Client;
let mailer: MailerService;
let ipCounter = 0;

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  app = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500' });
  api = makeClient(app, fx);
  mailer = app.get(MailerService);
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.end();
});

const errorCode = (res: { json: () => { error?: { code?: string } } }) => res.json().error?.code;
/** Each call comes from its own address so the per-address limits of one test do not affect another. */
const freshIp = () => `198.51.100.${++ipCounter}`;
const forgot = (body: Record<string, unknown>, ip = freshIp()) => app.inject({ method: 'POST', url: '/api/v1/auth/forgot-password', payload: body as never, remoteAddress: ip });
const reset = (token: string, newPassword: string, ip = freshIp()) => app.inject({ method: 'POST', url: '/api/v1/auth/reset-password', payload: { token, newPassword }, remoteAddress: ip });
const settle = () => new Promise((r) => setImmediate(r));
const asking = (who: string) => ({ tenant: fx.slug, email: fx.user(who).email });
const mailTo = (who: string) => mailer.outbox.filter((m) => m.to.toLowerCase() === fx.user(who).email.toLowerCase());
const tokenFrom = (text: string) => decodeURIComponent(/token=([^\s]+)/.exec(text)![1]!);
const NEW = 'Brand-new-pass-2026!';

describe('asking for a reset link', () => {
  it('emails a link to a real account', async () => {
    const res = await forgot(asking('lc1'));
    expect(res.statusCode).toBe(202);
    await settle();
    const [mail] = mailTo('lc1');
    expect(mail).toBeDefined();
    expect(mail!.subject).toContain('Reset your');
    expect(mail!.text).toMatch(/http:\/\/localhost:3000\/reset-password\?token=v1\.[0-9a-f-]{36}\./);
    expect(mail!.text).toContain('30 minutes');
    const row = (await owner.query(`SELECT token_hash, used_at FROM password_reset_tokens WHERE user_id = $1`, [fx.user('lc1').id])).rows[0];
    expect(row.used_at).toBeNull();
    expect(mail!.text).not.toContain(row.token_hash); // only a hash is stored
  });

  it('answers the same way for an address that has no account, an inactive one, or an unknown company', async () => {
    await owner.query(`UPDATE users SET status = 'inactive' WHERE id = $1`, [fx.user('lc3').id]);
    const known = await forgot(asking('lc2'));
    const answers = [
      known,
      await forgot({ tenant: fx.slug, email: 'nobody@test.example' }),
      await forgot(asking('lc3')),
      await forgot({ tenant: 'no-such-company', email: fx.user('lc2').email }),
    ];
    await settle();
    expect(new Set(answers.map((a) => a.statusCode))).toEqual(new Set([202]));
    expect(new Set(answers.map((a) => a.body)).size).toBe(1);
    expect(mailTo('lc2')).toHaveLength(1);
    expect(mailTo('lc3')).toHaveLength(0);
    expect(mailer.outbox.some((m) => m.to.startsWith('nobody@'))).toBe(false);
  });

  it('sends one email, not a pile, if asked again straight away', async () => {
    await forgot(asking('admin'));
    await forgot(asking('admin'));
    await forgot(asking('admin'));
    await settle();
    expect(mailTo('admin')).toHaveLength(1);
    expect(Number((await owner.query(`SELECT count(*) FROM password_reset_tokens WHERE user_id = $1`, [fx.user('admin').id])).rows[0].count)).toBe(1);
  });

  it('refuses malformed requests, and slows down one address that asks too often', async () => {
    expect(errorCode(await forgot({ tenant: fx.slug, email: 'not-an-email' }))).toBe('VALIDATION_FAILED');
    expect(errorCode(await forgot({ email: 'a@b.co' }))).toBe('VALIDATION_FAILED');
    const ip = freshIp();
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await forgot({ tenant: fx.slug, email: `x${i}@test.example` }, ip)).statusCode);
    expect(codes).toEqual([202, 202, 202, 202, 202, 429, 429]);
  });
});

describe('using the link', () => {
  const linkFor = async (who: string) => {
    await owner.query(`DELETE FROM password_reset_tokens WHERE user_id = $1`, [fx.user(who).id]);
    const before = mailTo(who).length;
    await forgot(asking(who));
    await settle();
    return tokenFrom(mailTo(who)[before]!.text);
  };

  it('sets the new password, ends every session and lifts a lock, once only', async () => {
    const oldSession = await api.signIn('lc1', { office: true });
    await owner.query(`UPDATE users SET failed_logins = 5, locked_until = now() + interval '1 hour' WHERE id = $1`, [fx.user('lc1').id]);
    const token = await linkFor('lc1');

    const done = await reset(token, NEW);
    expect(done.statusCode, done.body).toBe(200);
    expect((await owner.query(`SELECT failed_logins, locked_until FROM users WHERE id = $1`, [fx.user('lc1').id])).rows[0]).toEqual({ failed_logins: 0, locked_until: null });
    expect((await api.call('GET', '/auth/me', oldSession)).statusCode).toBe(401);
    const login = await api.login({ ...api.credentials('lc1', NEW), location: { lat: 28.6139, lng: 77.209, accuracy: 20 } }, '203.0.113.9');
    expect([200, 403]).toContain(login.statusCode); // password accepted (the office check may still apply)
    expect(login.statusCode === 403 ? errorCode(login) : 'ok').not.toBe('INVALID_CREDENTIALS');
    expect(errorCode(await api.login(api.credentials('lc1', PASSWORD)))).toBe('INVALID_CREDENTIALS');

    const again = await reset(token, 'Another-pass-2026!');
    expect(again.statusCode).toBe(400);
    expect(errorCode(again)).toBe('RESET_LINK_INVALID');
    expect((await owner.query(`SELECT action FROM audit_logs WHERE tenant_id = $1 AND entity_id = $2 AND action LIKE 'auth.password_reset%' ORDER BY id`, [fx.tenantId, fx.user('lc1').id])).rows.map((r) => r.action).slice(-2)).toEqual(['auth.password_reset_requested', 'auth.password_reset']);
  });

  it('rejects a weak password but keeps the link usable', async () => {
    const token = await linkFor('lc2');
    const weak = await reset(token, 'short');
    expect(weak.statusCode).toBe(400);
    expect(['PASSWORD_REJECTED', 'VALIDATION_FAILED']).toContain(errorCode(weak));
    const sameAsEmail = await reset(token, fx.user('lc2').email);
    expect(sameAsEmail.statusCode).toBe(400);
    expect((await reset(token, NEW)).statusCode).toBe(200);
  });

  it('refuses an expired link, a made-up one and a link cut about', async () => {
    const token = await linkFor('admin2');
    await owner.query(`UPDATE password_reset_tokens SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [fx.user('admin2').id]);
    expect(errorCode(await reset(token, NEW))).toBe('RESET_LINK_INVALID');

    const fresh = await linkFor('admin2');
    const [v, tenant, secret] = fresh.split('.') as [string, string, string];
    for (const bad of ['', 'junk', `${v}.${tenant}`, `${v}.${tenant}.${secret.slice(0, -1)}${secret.endsWith('A') ? 'B' : 'A'}`, `${v}.${fx.tenantId.replace(/.$/, (c) => (c === '0' ? '1' : '0'))}.${secret}`, `${v}.00000000-0000-0000-0000-000000000000.${secret}`, `${fresh}.extra`]) {
      const res = await reset(bad, NEW);
      expect(errorCode(res), bad).toBe('RESET_LINK_INVALID');
    }
    expect((await reset(fresh, NEW)).statusCode).toBe(200);
  });

  it('refuses a link whose account has since been switched off', async () => {
    const token = await linkFor('super');
    await owner.query(`UPDATE users SET status = 'inactive' WHERE id = $1`, [fx.user('super').id]);
    expect(errorCode(await reset(token, NEW))).toBe('RESET_LINK_INVALID');
  });

  it('slows down one address that keeps trying wrong links', async () => {
    const ip = freshIp();
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await reset('v1.nonsense', NEW, ip)).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 400)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
  });
});
