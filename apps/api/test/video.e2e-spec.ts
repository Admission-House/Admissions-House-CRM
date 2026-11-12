import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { startApp } from './helpers/app.js';
import { Client, makeClient } from './helpers/client.js';
import { createFixture, Fixture, OFFICE_IP } from './helpers/fixtures.js';

const APP_ID = '0123456789abcdef0123456789abcdef';
const CERT = 'fedcba9876543210fedcba9876543210';

let app: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;
let api: Client;
const t: Record<string, string> = {};
let seq = 0;

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  app = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500', AGORA_APP_ID: APP_ID, AGORA_APP_CERTIFICATE: CERT, VIDEO_MONTHLY_MINUTE_LIMIT: '9000', WEB_URL: 'https://crm.example.test' });
  api = makeClient(app, fx);
  t.sa = await api.signIn('super');
  t.admin = await api.signIn('admin', { office: true });
  t.lc = await api.signIn('counsellor', { office: true });
  t.lc2 = await api.signIn('counsellor2', { office: true });
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.end();
});

async function leadOf(holder: string): Promise<string> {
  const n = ++seq;
  const status = (await owner.query(`SELECT id FROM lead_statuses WHERE tenant_id = $1 ORDER BY sort_order LIMIT 1`, [fx.tenantId])).rows[0].id;
  const { rows } = await owner.query(
    `INSERT INTO leads (tenant_id, lead_no, name, primary_phone, status_id, source_id, assigned_to, assigned_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now()) RETURNING id`,
    [fx.tenantId, 8_200_000 + n, `Video Student ${n}`, `9177${String(30_000_000 + n)}`, status, fx.sourceId('Website'), fx.user(holder).id],
  );
  return rows[0].id as string;
}

const create = (token: string, lead: string, body: Record<string, unknown> = {}, ip?: string) => api.call('POST', `/leads/${lead}/video-sessions`, token, body, ip);
const guest = (token: string, ip = '203.0.113.77') => app.inject({ method: 'POST', url: '/api/v1/video/guest/join', payload: { token }, remoteAddress: ip });
const linkToken = (url: string) => url.split('/meet/')[1]!;

describe('opening a session', () => {
  it('a counsellor opens one for their own lead and gets a link for the student', async () => {
    const lead = await leadOf('counsellor');
    const res = await create(t.lc!, lead, { maxMinutes: 30 }, OFFICE_IP);
    expect(res.statusCode, res.body).toBe(201);
    const s = res.json();
    expect(s).toMatchObject({ leadId: lead, status: 'open', maxMinutes: 30, startedAt: null });
    expect(s.guestUrl).toMatch(/^https:\/\/crm\.example\.test\/meet\/[0-9a-f-]{36}\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    const list = await api.call('GET', `/leads/${lead}/video-sessions`, t.lc!, undefined, OFFICE_IP);
    expect(list.json().map((x: { id: string }) => x.id)).toEqual([s.id]);
    // The same link every time it is asked for.
    expect(list.json()[0].guestUrl).toBe(s.guestUrl);
    const note = await owner.query(`SELECT remark FROM lead_activities WHERE lead_id = $1 AND type = 'note'`, [lead]);
    expect(note.rows[0].remark).toMatch(/Video session created by/);
  });

  it('a lead that is not theirs is a 404, and without the permission it is a 403', async () => {
    const other = await leadOf('counsellor2');
    expect((await create(t.lc!, other, {}, OFFICE_IP)).statusCode).toBe(404);
    const mine = await leadOf('counsellor');
    // Permissions are read on every request, so taking it away and giving it back is enough.
    const role = `SELECT role_id FROM users WHERE id = '${fx.user('counsellor').id}'`;
    const removed = await owner.query(`DELETE FROM role_permissions WHERE role_id = (${role}) AND permission_id = (SELECT id FROM permissions WHERE code = 'video.host') RETURNING tenant_id, role_id, permission_id`);
    try {
      expect((await create(t.lc!, mine, {}, OFFICE_IP)).statusCode).toBe(403);
    } finally {
      for (const r of removed.rows) await owner.query(`INSERT INTO role_permissions (tenant_id, role_id, permission_id) VALUES ($1, $2, $3)`, [r.tenant_id, r.role_id, r.permission_id]);
    }
  });

  it('refuses a time in the past and a session length outside 5 to 240 minutes', async () => {
    const lead = await leadOf('counsellor');
    expect((await create(t.lc!, lead, { scheduledFor: '2020-01-01T10:00:00Z' }, OFFICE_IP)).json().error.code).toBe('SCHEDULE_IN_PAST');
    expect((await create(t.lc!, lead, { maxMinutes: 2 }, OFFICE_IP)).statusCode).toBe(400);
    expect((await create(t.lc!, lead, { maxMinutes: 500 }, OFFICE_IP)).statusCode).toBe(400);
  });
});

describe('joining', () => {
  it('staff get a token for the channel; the clock starts on the first join and stays', async () => {
    const lead = await leadOf('counsellor');
    const s = (await create(t.lc!, lead, { maxMinutes: 20 }, OFFICE_IP)).json();
    const first = await api.call('POST', `/video-sessions/${s.id}/join`, t.lc!, undefined, OFFICE_IP);
    expect(first.statusCode, first.body).toBe(200);
    const j = first.json();
    expect(j).toMatchObject({ appId: APP_ID, channel: `ah${s.id.replace(/-/g, '')}` });
    expect(j.token.startsWith('007')).toBe(true);
    expect(j.uid).toBeGreaterThanOrEqual(1);
    expect(j.secondsLeft).toBeLessThanOrEqual(1200);
    const started = (await owner.query(`SELECT started_at FROM video_sessions WHERE id = $1`, [s.id])).rows[0].started_at as Date;
    expect(started).not.toBeNull();

    const second = (await api.call('POST', `/video-sessions/${s.id}/join`, t.lc!, undefined, OFFICE_IP)).json();
    expect(second.uid).not.toBe(j.uid);
    expect((await owner.query(`SELECT started_at FROM video_sessions WHERE id = $1`, [s.id])).rows[0].started_at).toEqual(started);
  });

  it('the student joins the same channel with only the link', async () => {
    const lead = await leadOf('counsellor');
    const s = (await create(t.lc!, lead, {}, OFFICE_IP)).json();
    const staff = (await api.call('POST', `/video-sessions/${s.id}/join`, t.lc!, undefined, OFFICE_IP)).json();
    const res = await guest(linkToken(s.guestUrl));
    expect(res.statusCode, res.body).toBe(200);
    const g = res.json();
    expect(g.channel).toBe(staff.channel);
    expect(g.uid).not.toBe(staff.uid);
    expect(g.token).not.toBe(staff.token);
    expect(g).toMatchObject({ appId: APP_ID, firstName: expect.stringMatching(/^Video$/), counsellorName: expect.any(String), companyName: expect.any(String) });
    // Nothing secret reaches the student.
    expect(JSON.stringify(g)).not.toContain(CERT);
  });

  it('refuses a made-up or altered link with the same answer, and slows down repeated guesses', async () => {
    const lead = await leadOf('counsellor');
    const s = (await create(t.lc!, lead, {}, OFFICE_IP)).json();
    const link = linkToken(s.guestUrl);
    const altered = link.slice(0, -1) + (link.endsWith('A') ? 'B' : 'A');
    expect((await guest(altered, '198.51.100.9')).statusCode).toBe(404);
    expect((await guest(`${fx.tenantId}.${randomUUID()}.${link.split('.')[2]}`, '198.51.100.9')).statusCode).toBe(404);
    expect((await guest('x'.repeat(60), '198.51.100.9')).statusCode).toBe(404);
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await guest(altered, '198.51.100.9')).statusCode;
    expect(last).toBe(429);
  });

  it('a link for a session of another company cannot be used for this one', async () => {
    const lead = await leadOf('counsellor');
    const s = (await create(t.lc!, lead, {}, OFFICE_IP)).json();
    const [, , mac] = linkToken(s.guestUrl).split('.');
    // The right session id with another company's id: the signature no longer matches.
    expect((await guest(`${randomUUID()}.${s.id}.${mac}`, '198.51.100.10')).statusCode).toBe(404);
  });
});

describe('ending and expiry', () => {
  it('after the session is ended nobody can join, student or staff', async () => {
    const lead = await leadOf('counsellor');
    const s = (await create(t.lc!, lead, {}, OFFICE_IP)).json();
    await api.call('POST', `/video-sessions/${s.id}/join`, t.lc!, undefined, OFFICE_IP);
    const ended = await api.call('POST', `/video-sessions/${s.id}/end`, t.lc!, undefined, OFFICE_IP);
    expect(ended.statusCode, ended.body).toBe(200);
    expect(ended.json()).toMatchObject({ status: 'ended', endedAt: expect.any(String) });
    expect((await guest(linkToken(s.guestUrl))).json().error.code).toBe('SESSION_ENDED');
    expect((await api.call('POST', `/video-sessions/${s.id}/join`, t.lc!, undefined, OFFICE_IP)).json().error.code).toBe('SESSION_ENDED');
    // Ending again is harmless.
    expect((await api.call('POST', `/video-sessions/${s.id}/end`, t.lc!, undefined, OFFICE_IP)).statusCode).toBe(200);
  });

  it('a link not used before it expires, and a call past its agreed minutes, are refused', async () => {
    const lead = await leadOf('counsellor');
    const a = (await create(t.lc!, lead, {}, OFFICE_IP)).json();
    await owner.query(`UPDATE video_sessions SET expires_at = now() - interval '1 minute' WHERE id = $1`, [a.id]);
    expect((await guest(linkToken(a.guestUrl))).json().error.code).toBe('LINK_EXPIRED');

    const b = (await create(t.lc!, lead, { maxMinutes: 10 }, OFFICE_IP)).json();
    await owner.query(`UPDATE video_sessions SET started_at = now() - interval '11 minutes' WHERE id = $1`, [b.id]);
    expect((await guest(linkToken(b.guestUrl))).json().error.code).toBe('SESSION_ENDED');
  });

  it('only people who can see the lead may join or end the session as staff', async () => {
    const lead = await leadOf('counsellor');
    const s = (await create(t.lc!, lead, {}, OFFICE_IP)).json();
    expect((await api.call('POST', `/video-sessions/${s.id}/join`, t.lc2!, undefined, OFFICE_IP)).statusCode).toBe(404);
    expect((await api.call('POST', `/video-sessions/${s.id}/end`, t.lc2!, undefined, OFFICE_IP)).statusCode).toBe(404);
    expect((await api.call('POST', `/video-sessions/${s.id}/join`, t.sa!)).statusCode).toBe(200);
  });
});

describe('the monthly limit', () => {
  it('counts started sessions and stops a new one that would go past the limit', async () => {
    const lead = await leadOf('counsellor');
    const used = async () => (await api.call('GET', '/video-sessions/usage', t.sa!)).json();
    const before = await used();
    expect(before).toMatchObject({ limitStandardMinutes: 9000, callMinutesLimit: 1125 });

    // A finished 30-minute call is 30 call minutes: two people, 4 Standard minutes each per minute (Video HD 1:4) = 240.
    const s = (await create(t.lc!, lead, { maxMinutes: 30 }, OFFICE_IP)).json();
    await owner.query(`UPDATE video_sessions SET started_at = now() - interval '40 minutes', status = 'ended', ended_at = now() - interval '10 minutes' WHERE id = $1`, [s.id]);
    const after = await used();
    expect(after.callMinutesUsed - before.callMinutesUsed).toBe(30);
    expect(after.usedStandardMinutes - before.usedStandardMinutes).toBe(240);

    // Fill the month, then a session that has not started cannot start.
    const next = (await create(t.lc!, lead, { maxMinutes: 60 }, OFFICE_IP)).json();
    // 25 sessions of 240 minutes:  25 x 240 x 8 = 48,000 Standard minutes against a limit of 9,000.
    await owner.query(`INSERT INTO video_sessions (tenant_id, lead_id, created_by, expires_at, max_minutes, status, started_at, ended_at)
                       SELECT $1, $2, $3, now() + interval '1 day', 240, 'ended', now() - interval '5 hours', now() - interval '1 hour' FROM generate_series(1, 25)`, [fx.tenantId, lead, fx.user('counsellor').id]);
    const res = await api.call('POST', `/video-sessions/${next.id}/join`, t.lc!, undefined, OFFICE_IP);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('VIDEO_LIMIT_REACHED');
    expect((await guest(linkToken(next.guestUrl))).json().error.code).toBe('VIDEO_LIMIT_REACHED');
  });
});

describe('when video is not set up', () => {
  it('says so clearly instead of failing', async () => {
    const bare = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500', AGORA_APP_ID: '', AGORA_APP_CERTIFICATE: '' });
    try {
      const c = makeClient(bare, fx);
      const token = await c.signIn('super');
      expect((await c.call('GET', '/video-sessions/status', token)).json()).toEqual({ enabled: false });
      const lead = await leadOf('counsellor');
      const res = await c.call('POST', `/leads/${lead}/video-sessions`, token, {});
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('VIDEO_NOT_CONFIGURED');
    } finally {
      await bare.close();
    }
  });

  it('reports that it is enabled when the credentials are present', async () => {
    expect((await api.call('GET', '/video-sessions/status', t.sa!)).json()).toEqual({ enabled: true });
  });
});
