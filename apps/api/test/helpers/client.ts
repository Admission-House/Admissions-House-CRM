import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { expect } from 'vitest';
import { Fixture, OFFICE, OFFICE_IP, OUTSIDE_IP, PASSWORD } from './fixtures.js';

export const inOffice = { lat: OFFICE.lat, lng: OFFICE.lng, accuracy: 20 };

type Body = Record<string, unknown>;

/** Small helpers for calling the API in tests as a given user. */
export function makeClient(app: NestFastifyApplication, fx: Fixture) {
  const login = (body: Body, ip = OUTSIDE_IP) =>
    app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: body, remoteAddress: ip });

  const credentials = (name: string, password = PASSWORD) => ({ tenant: fx.slug, email: fx.user(name).email, password });

  /** Signs in and returns the access token. Admins and counsellors sign in from the office. */
  async function signIn(name: string, opts: { office?: boolean; extra?: Body } = {}): Promise<string> {
    const body = opts.office ? { ...credentials(name), location: inOffice, ...opts.extra } : { ...credentials(name), ...opts.extra };
    const res = await login(body, opts.office ? OFFICE_IP : OUTSIDE_IP);
    expect(res.statusCode, `sign-in of ${name}: ${res.body}`).toBe(200);
    return res.json().accessToken as string;
  }

  const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, token: string, payload?: Body, ip = OUTSIDE_IP) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${token}` },
      payload: payload as never,
      remoteAddress: ip,
    });

  return { login, credentials, signIn, call };
}

export type Client = ReturnType<typeof makeClient>;
