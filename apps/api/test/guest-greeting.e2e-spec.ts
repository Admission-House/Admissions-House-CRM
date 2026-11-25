import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { startApp } from './helpers/app.js';
import { Client, makeClient } from './helpers/client.js';
import { createFixture, Fixture, OFFICE_IP } from './helpers/fixtures.js';

let app: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;
let api: Client;
const t: Record<string, string> = {};

const call = (
  token: string,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  body?: Record<string, unknown>,
) => api.call(method, url, token, body, token === t.sa ? undefined : OFFICE_IP);
const info = (token: string, ip = '203.0.113.61') =>
  app.inject({
    method: 'POST',
    url: '/api/v1/video/guest/info',
    payload: { token },
    remoteAddress: ip,
  });
const join = (token: string, deviceId: string) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/video/guest/join',
    payload: { token, deviceId },
    remoteAddress: '203.0.113.62',
  });
const linkOf = (url: string) => url.split('/meet/')[1]!;
let seq = 0;

async function callFromLead(): Promise<{ id: string; guest: { id: string; link: string } }> {
  const n = ++seq;
  const status = (
    await owner.query(
      `SELECT id FROM lead_statuses WHERE tenant_id = $1 ORDER BY sort_order LIMIT 1`,
      [fx.tenantId],
    )
  ).rows[0].id;
  const lead = (
    await owner.query(
      `INSERT INTO leads (tenant_id, lead_no, name, primary_phone, status_id, source_id, assigned_to, assigned_at) VALUES ($1, $2, $3, $4, $5, $6, $7, now()) RETURNING id`,
      [
        fx.tenantId,
        9_300_000 + n,
        `Rahul Greeting ${n}`,
        `9166${String(60_000_000 + n)}`,
        status,
        fx.sourceId('Website'),
        fx.user('counsellor').id,
      ],
    )
  ).rows[0].id as string;
  const res = await call(t.lc!, 'POST', `/leads/${lead}/communications`, { kind: 'video' });
  expect(res.statusCode, res.body).toBe(201);
  const s = res.json();
  return { id: s.id, guest: s.participants.find((p: { kind: string }) => p.kind === 'guest') };
}

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  app = await startApp({
    LOGIN_IP_MAX_ATTEMPTS: '500',
    AGORA_APP_ID: '0123456789abcdef0123456789abcdef',
    AGORA_APP_CERTIFICATE: 'fedcba9876543210fedcba9876543210',
    WEB_URL: 'https://crm.example.test',
  });
  api = makeClient(app, fx);
  t.sa = await api.signIn('super');
  t.lc = await api.signIn('counsellor', { office: true });
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.end();
});

describe("the student's greeting before joining", () => {
  it('says who is calling, with nothing that lets the student in', async () => {
    const { guest } = await callFromLead();
    const res = await info(linkOf(guest.link));
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      kind: 'video',
      ended: false,
      hostName: expect.any(String),
      companyName: expect.any(String),
      guestName: expect.stringMatching(/Rahul/),
    });
    expect(body.hostName).toBe(
      (await owner.query(`SELECT name FROM users WHERE id = $1`, [fx.user('counsellor').id]))
        .rows[0].name,
    );
    expect(Object.keys(body).sort()).toEqual([
      'companyName',
      'ended',
      'guestName',
      'hostName',
      'kind',
      'title',
    ]);
    expect(JSON.stringify(body)).not.toMatch(/007|agora|appId|token|channel/i);
  });

  it('changes nothing: the call does not start and the link is not tied to a device, so the student can still join from any device', async () => {
    const { id, guest } = await callFromLead();
    await info(linkOf(guest.link));
    await info(linkOf(guest.link));
    const row = (
      await owner.query(
        `SELECT i.device_hash, v.started_at FROM video_session_invites i JOIN video_sessions v ON v.id = i.session_id WHERE i.id = $1`,
        [guest.id],
      )
    ).rows[0];
    expect(row.device_hash).toBeNull();
    expect(row.started_at).toBeNull();
    // The host opens the room, then the student joins from their own device.
    expect((await call(t.lc!, 'POST', `/communications/${id}/join`)).statusCode).toBe(200);
    const joined = await join(linkOf(guest.link), 'student-device-aaaaaaaaaaaaaaaaaa');
    expect(joined.statusCode, joined.body).toBe(200);
    // Now the link belongs to that device; the greeting still works from anywhere, but joining from another device is refused.
    expect((await info(linkOf(guest.link))).statusCode).toBe(200);
    expect((await join(linkOf(guest.link), 'another-device-bbbbbbbbbbbbbbbbbbbb')).statusCode).toBe(
      409,
    );
  });

  it('treats a link that is wrong, changed or too short like any other, and does not tell them apart', async () => {
    const { guest } = await callFromLead();
    const token = linkOf(guest.link);
    const changed = token.slice(0, -3) + (token.endsWith('aaa') ? 'bbb' : 'aaa');
    expect((await info(changed)).statusCode).toBe(404);
    expect((await info('x'.repeat(60))).statusCode).toBe(404);
    expect((await info('short')).statusCode).toBe(400);
  });

  it('says so when the call is over, instead of offering to join', async () => {
    const { id, guest } = await callFromLead();
    expect((await info(linkOf(guest.link))).json().ended).toBe(false);
    expect((await call(t.lc!, 'POST', `/communications/${id}/end`)).statusCode).toBe(200);
    expect((await info(linkOf(guest.link))).json().ended).toBe(true);
  });

  it('shows nothing to a student who was taken out of the call: the link is cancelled and looks like any wrong link', async () => {
    const { id, guest } = await callFromLead();
    expect(
      (await call(t.lc!, 'POST', `/communications/${id}/invites/${guest.id}/remove`)).statusCode,
    ).toBe(200);
    expect((await info(linkOf(guest.link))).statusCode).toBe(404);
  });

  it('slows down someone who keeps trying wrong links', async () => {
    let last = 0;
    for (let i = 0; i < 40; i++) last = (await info('y'.repeat(60) + i, '203.0.113.99')).statusCode;
    expect([404, 429]).toContain(last);
    expect((await info('z'.repeat(60), '203.0.113.99')).statusCode).toBe(429);
  });
});

describe('whether phone calling is set up (so the Call buttons are shown only when they can work)', () => {
  it('says "not ready" until a calling provider is connected, then "ready"', async () => {
    expect((await call(t.lc!, 'GET', '/calls/ready')).json()).toEqual({ ready: false });
    expect(
      (
        await call(t.sa!, 'PUT', '/telephony/connection', {
          provider: 'generic',
          config: { simulate: true },
        })
      ).statusCode,
    ).toBe(200);
    expect((await call(t.lc!, 'GET', '/calls/ready')).json()).toEqual({ ready: true });
    expect(
      (
        await call(t.sa!, 'PUT', '/telephony/connection', {
          provider: 'generic',
          isEnabled: false,
          config: { simulate: true },
        })
      ).statusCode,
    ).toBe(200);
    expect((await call(t.lc!, 'GET', '/calls/ready')).json()).toEqual({ ready: false });
  });

  it('is for signed-in people only', async () => {
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/calls/ready',
          remoteAddress: '203.0.113.70',
        })
      ).statusCode,
    ).toBe(401);
  });
});
