import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { startApp } from './helpers/app.js';

describe('HTTP layer', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await startApp({ CORS_ORIGINS: 'https://crm.example' });
  });
  afterAll(async () => {
    await app.close();
  });

  it('liveness and readiness (database) both answer ok', async () => {
    const live = await app.inject({ method: 'GET', url: '/api/v1/health/live' });
    const ready = await app.inject({ method: 'GET', url: '/api/v1/health/ready' });
    expect(live.statusCode).toBe(200);
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: 'ok' });
  });

  it('sets security headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health/live' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  describe('request id', () => {
    it('keeps a sane id sent by the caller and returns it', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/health/live', headers: { 'x-request-id': 'client-id-12345' } });
      expect(res.headers['x-request-id']).toBe('client-id-12345');
    });

    it('replaces an id that could be used to forge log lines', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/health/live', headers: { 'x-request-id': 'bad id <script>' } });
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe('errors use one shape', () => {
    it('unknown route', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/nope' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        error: { code: 'NOT_FOUND', message: expect.any(String), requestId: res.headers['x-request-id'] },
      });
    });

    it('invalid JSON', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/health/live', headers: { 'content-type': 'application/json' }, payload: '{bad' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatchObject({ code: 'BAD_REQUEST', requestId: res.headers['x-request-id'] });
    });

    it('a body over the limit', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/health/live',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ x: 'a'.repeat(1_100_000) }),
      });
      expect(res.statusCode).toBe(413);
      expect(res.json().error.code).toBe('PAYLOAD_TOO_LARGE');
    });
  });

  describe('CORS', () => {
    it('allows a configured origin', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/health/live', headers: { origin: 'https://crm.example' } });
      expect(res.headers['access-control-allow-origin']).toBe('https://crm.example');
    });

    it('does not allow any other origin', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/health/live', headers: { origin: 'https://evil.example' } });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});

describe('client IP (the office check depends on it)', () => {
  const forwarded = { 'x-forwarded-for': '198.51.100.7, 10.0.0.2' };

  it('ignores X-Forwarded-For when no proxy is configured', async () => {
    const app = await startApp({ TRUST_PROXY_HOPS: '0' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/test/ip', headers: forwarded, remoteAddress: '10.0.0.1' });
    expect(res.json().ip).toBe('10.0.0.1');
    await app.close();
  });

  it('with one proxy, uses the address that proxy reports and ignores anything the client prepended', async () => {
    const app = await startApp({ TRUST_PROXY_HOPS: '1' });
    // The client claims to be 6.6.6.6; the single proxy appended the real client, 198.51.100.7.
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/test/ip',
      headers: { 'x-forwarded-for': '6.6.6.6, 198.51.100.7' },
      remoteAddress: '10.0.0.1',
    });
    expect(res.json().ip).toBe('198.51.100.7');
    await app.close();
  });
});
