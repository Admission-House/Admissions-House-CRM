import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { loadEnv } from '../config/env.js';
import { newPasswordSchema, passwordProblem, PasswordService } from './password.service.js';
import { hashToken, safeEqualHex, TokenService } from './token.service.js';

const secret = 'a-test-secret-that-is-long-enough-for-hs256';
const env = loadEnv({
  DATABASE_URL: 'postgresql://ah_app:x@localhost:5433/admission_house',
  JWT_ACCESS_SECRET: secret,
  DATA_ENCRYPTION_KEY: 'ab'.repeat(32),
});
const claims = { userId: randomUUID(), tenantId: randomUUID(), sessionId: randomUUID() };

describe('TokenService access tokens', () => {
  const tokens = new TokenService(env);

  it('round-trips the user, company and session', async () => {
    const { token, expiresInSec } = await tokens.signAccess(claims);
    expect(expiresInSec).toBe(900);
    await expect(tokens.verifyAccess(token)).resolves.toEqual(claims);
  });

  it('carries no permissions or role, which are looked up on every request', async () => {
    const { token } = await tokens.signAccess(claims);
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
    expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'sid', 'sub', 'tid']);
  });

  it('rejects a token signed with another secret', async () => {
    const other = new TokenService({ ...env, JWT_ACCESS_SECRET: 'another-secret-that-is-also-long-enough-xx' });
    const { token } = await other.signAccess(claims);
    await expect(tokens.verifyAccess(token)).rejects.toMatchObject({ code: 'TOKEN_INVALID', status: 401 });
  });

  it('rejects an expired token', async () => {
    const expired = await new SignJWT({ tid: claims.tenantId, sid: claims.sessionId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.userId)
      .setIssuer('admissions-house-crm')
      .setAudience('admissions-house-crm-api')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 600)
      .sign(new TextEncoder().encode(secret));
    await expect(tokens.verifyAccess(expired)).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
  });

  it('rejects an unsigned token (alg none)', async () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const forged = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: claims.userId, tid: claims.tenantId, sid: claims.sessionId, iss: 'admissions-house-crm', aud: 'admissions-house-crm-api', exp: 9999999999 })}.`;
    await expect(tokens.verifyAccess(forged)).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
  });

  it('rejects a token meant for another audience', async () => {
    const wrong = await new SignJWT({ tid: claims.tenantId, sid: claims.sessionId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.userId)
      .setIssuer('admissions-house-crm')
      .setAudience('some-other-service')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(secret));
    await expect(tokens.verifyAccess(wrong)).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
  });

  it('rejects garbage', async () => {
    await expect(tokens.verifyAccess('not-a-token')).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
    await expect(tokens.verifyAccess('')).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
  });
});

describe('TokenService refresh tokens', () => {
  const tokens = new TokenService(env);
  const parts = { tenantId: randomUUID(), sessionId: randomUUID() };

  it('is parsed back into company and session', () => {
    const { token } = tokens.newRefreshToken(parts);
    expect(tokens.parseRefreshToken(token)).toEqual(parts);
  });

  it('is different every time and is stored only as a hash', () => {
    const a = tokens.newRefreshToken(parts);
    const b = tokens.newRefreshToken(parts);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toBe(hashToken(a.token));
    expect(a.hash).not.toContain(a.token.split('.')[3]);
  });

  it.each(['', 'v1.x.y.z', `v2.${randomUUID()}.${randomUUID()}.${'a'.repeat(43)}`, `v1.${randomUUID()}.${randomUUID()}.short`])(
    'refuses a malformed token: %s',
    (bad) => {
      expect(tokens.parseRefreshToken(bad)).toBeNull();
    },
  );
});

describe('safeEqualHex', () => {
  it('compares hashes', () => {
    expect(safeEqualHex(hashToken('a'), hashToken('a'))).toBe(true);
    expect(safeEqualHex(hashToken('a'), hashToken('b'))).toBe(false);
    expect(safeEqualHex('', '')).toBe(false);
    expect(safeEqualHex('ab', 'abcd')).toBe(false);
  });
});

describe('passwords', () => {
  const service = new PasswordService();

  it('hashes with argon2id and verifies', async () => {
    const hash = await service.hash('correct horse 42');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    await expect(service.verify(hash, 'correct horse 42')).resolves.toBe(true);
    await expect(service.verify(hash, 'wrong horse 42')).resolves.toBe(false);
  });

  it('treats a malformed hash as a wrong password instead of throwing', async () => {
    await expect(service.verify('not-a-hash', 'anything')).resolves.toBe(false);
  });

  describe('policy', () => {
    it.each(['short1', 'onlyletterspassword', '12345678901'])('rejects %s', (p) => {
      expect(newPasswordSchema.safeParse(p).success).toBe(false);
    });
    it('accepts a long password with letters and numbers', () => {
      expect(newPasswordSchema.safeParse('blue-river-2026').success).toBe(true);
    });
    it('rejects a password built from the email name', () => {
      expect(passwordProblem('Bhavesh2026!!', 'bhavesh@example.com')).toMatch(/email/);
      expect(passwordProblem('blue-river-2026', 'bhavesh@example.com')).toBeNull();
    });
  });
});
