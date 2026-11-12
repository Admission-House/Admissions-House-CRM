import { randomBytes, randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { VideoSweepService } from '../src/video/video-sweep.service.js';
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
  t.mobile = await api.signIn('mobile', { office: true });
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.end();
});

// ------------------------------------------------------------------ helpers

const device = () => randomBytes(18).toString('base64url');
const sweep = () => app.get(VideoSweepService).runOnce();

async function leadOf(holder: string): Promise<string> {
  const n = ++seq;
  const status = (await owner.query(`SELECT id FROM lead_statuses WHERE tenant_id = $1 ORDER BY sort_order LIMIT 1`, [fx.tenantId])).rows[0].id;
  const { rows } = await owner.query(
    `INSERT INTO leads (tenant_id, lead_no, name, primary_phone, status_id, source_id, assigned_to, assigned_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now()) RETURNING id`,
    [fx.tenantId, 8_300_000 + n, `Video Student ${n}`, `9166${String(40_000_000 + n)}`, status, fx.sourceId('Website'), fx.user(holder).id],
  );
  return rows[0].id as string;
}

const call = (token: string, method: 'GET' | 'POST', url: string, body?: Record<string, unknown>) => api.call(method, url, token, body, token === t.sa ? undefined : OFFICE_IP);
const guestPost = (url: string, body: Record<string, unknown>, ip = '203.0.113.77') => app.inject({ method: 'POST', url: `/api/v1/video/guest/${url}`, payload: body, remoteAddress: ip });
const linkOf = (url: string) => url.split('/meet/')[1]!;
const code = (res: { json: () => { error?: { code?: string } } }) => res.json().error?.code;

/** A session with the lead, started from the lead's page. */
async function leadSession(holder: 'counsellor' | 'counsellor2' | 'mobile' = 'counsellor', body: Record<string, unknown> = {}) {
  const lead = await leadOf(holder);
  const token = holder === 'counsellor' ? t.lc! : holder === 'counsellor2' ? t.lc2! : t.mobile!;
  const res = await call(token, 'POST', `/leads/${lead}/communications`, body);
  expect(res.statusCode, res.body).toBe(201);
  return { lead, token, session: res.json(), guest: res.json().participants.find((p: { kind: string }) => p.kind === 'guest') as { id: string; link: string } };
}

const notes = async (user: string, event: string) =>
  (await owner.query(`SELECT payload FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND type = 'communication' AND payload->>'event' = $3`, [fx.tenantId, fx.user(user).id, event])).rows.map((r) => r.payload as Record<string, unknown>);

const sessionRow = async (id: string) => (await owner.query(`SELECT * FROM video_sessions WHERE id = $1`, [id])).rows[0];
const inviteOf = async (sessionId: string, who: string) => (await owner.query(`SELECT * FROM video_session_invites WHERE session_id = $1 AND user_id = $2`, [sessionId, fx.user(who).id])).rows[0];

// ================================================================ a call with a lead

describe('a call with a lead', () => {
  it('is made from the lead\'s page: the counsellor is the host, the lead gets an invitation and a link', async () => {
    const { lead, token, session, guest } = await leadSession('counsellor', { kind: 'voice', maxMinutes: 30 });
    expect(session).toMatchObject({ type: 'call', kind: 'voice', leadId: lead, phase: 'waiting', status: 'open', maxMinutes: 30, canManage: true, recordingStatus: 'not_enabled' });
    expect(session.participants.map((p: { kind: string; role: string; state: string }) => [p.kind, p.role, p.state])).toEqual([['staff', 'host', 'accepted'], ['guest', 'participant', 'invited']]);
    expect(guest.link).toMatch(/^https:\/\/crm\.example\.test\/meet\/[0-9a-f-]{36}\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    const list = (await call(token, 'GET', `/leads/${lead}/communications`)).json();
    expect(list.map((s: { id: string }) => s.id)).toEqual([session.id]);
    expect(list[0].participants[1].link).toBe(guest.link); // the same link whenever it is asked for
    const note = await owner.query(`SELECT remark FROM lead_activities WHERE lead_id = $1 AND type = 'note'`, [lead]);
    expect(note.rows[0].remark).toMatch(/^Voice call created by/);
  });

  it('a lead that is not theirs is a 404, and without the permission it is a 403', async () => {
    const other = await leadOf('counsellor2');
    expect((await call(t.lc!, 'POST', `/leads/${other}/communications`, {})).statusCode).toBe(404);
    const mine = await leadOf('counsellor');
    const role = `SELECT role_id FROM users WHERE id = '${fx.user('counsellor').id}'`;
    const removed = await owner.query(`DELETE FROM role_permissions WHERE role_id = (${role}) AND permission_id = (SELECT id FROM permissions WHERE code = 'video.host') RETURNING tenant_id, role_id, permission_id`);
    try {
      expect((await call(t.lc!, 'POST', `/leads/${mine}/communications`, {})).statusCode).toBe(403);
    } finally {
      for (const r of removed.rows) await owner.query(`INSERT INTO role_permissions (tenant_id, role_id, permission_id) VALUES ($1, $2, $3)`, [r.tenant_id, r.role_id, r.permission_id]);
    }
  });

  it('refuses a time in the past, a length outside 5 to 240 minutes, and a kind that does not exist', async () => {
    const lead = await leadOf('counsellor');
    expect(code(await call(t.lc!, 'POST', `/leads/${lead}/communications`, { scheduledFor: '2020-01-01T10:00:00Z' }))).toBe('SCHEDULE_IN_PAST');
    for (const bad of [{ maxMinutes: 2 }, { maxMinutes: 500 }, { kind: 'hologram' }]) expect((await call(t.lc!, 'POST', `/leads/${lead}/communications`, bad)).statusCode).toBe(400);
  });

  it('gives staff a token for the channel with a stable number, renewed on the same address, and starts the clock once', async () => {
    const { token, session } = await leadSession('counsellor', { maxMinutes: 20 });
    const first = (await call(token, 'POST', `/communications/${session.id}/join`)).json();
    expect(first).toMatchObject({ appId: APP_ID, channel: `ah${session.id.replace(/-/g, '')}`, kind: 'video', type: 'call' });
    expect(first.token.startsWith('007')).toBe(true);
    expect(first.tokenSeconds).toBeLessThanOrEqual(300);
    expect(first.secondsLeft).toBeLessThanOrEqual(1200);
    const started = (await sessionRow(session.id)).started_at as Date;
    expect(started).not.toBeNull();
    const again = (await call(token, 'POST', `/communications/${session.id}/join`)).json();
    expect(again.uid).toBe(first.uid); // one person, one number: a second screen replaces the first
    expect(again.token).not.toBe(first.token === again.token ? '' : first.token);
    expect((await sessionRow(session.id)).started_at).toEqual(started);
  });

  it('lets the lead in with the link and one device, in the same channel, without signing in', async () => {
    const { token, session, guest } = await leadSession();
    const staff = (await call(token, 'POST', `/communications/${session.id}/join`)).json();
    const dev = device();
    const res = await guestPost('join', { token: linkOf(guest.link), deviceId: dev });
    expect(res.statusCode, res.body).toBe(200);
    const g = res.json();
    expect(g).toMatchObject({ channel: staff.channel, appId: APP_ID, kind: 'video', hostName: expect.any(String), companyName: expect.any(String), guestName: 'Video' });
    expect(g.uid).not.toBe(staff.uid);
    expect(JSON.stringify(g)).not.toContain(CERT);
    // The same device may come back (renewal, a reload) ...
    expect((await guestPost('join', { token: linkOf(guest.link), deviceId: dev })).statusCode).toBe(200);
    // ... another device may not, until the host releases the link.
    const other = await guestPost('join', { token: linkOf(guest.link), deviceId: device() });
    expect(other.statusCode).toBe(409);
    expect(code(other)).toBe('INVITE_USED_ELSEWHERE');
    expect((await call(token, 'POST', `/communications/${session.id}/invites/${guest.id}/reset-device`)).statusCode).toBe(200);
    expect((await guestPost('join', { token: linkOf(guest.link), deviceId: device() })).statusCode).toBe(200);
  });

  it('lets the guest correct how their name is shown', async () => {
    const { token, session, guest } = await leadSession();
    await guestPost('join', { token: linkOf(guest.link), deviceId: device(), name: 'Zeenat Khan' });
    const seen = (await call(token, 'GET', `/communications/${session.id}`)).json();
    expect(seen.participants.find((p: { kind: string }) => p.kind === 'guest').name).toBe('Zeenat Khan');
  });

  it('refuses made-up, altered and wrong-company links with one answer, and slows repeated guesses', async () => {
    const { guest } = await leadSession();
    const link = linkOf(guest.link);
    const ip = '198.51.100.9';
    const altered = link.slice(0, -1) + (link.endsWith('A') ? 'B' : 'A');
    for (const bad of [altered, `${fx.tenantId}.${randomUUID()}.${link.split('.')[2]}`, `${randomUUID()}.${link.split('.')[1]}.${link.split('.')[2]}`, 'x'.repeat(60)]) {
      const res = await guestPost('join', { token: bad, deviceId: device() }, ip);
      expect([404, 400]).toContain(res.statusCode);
    }
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await guestPost('join', { token: altered, deviceId: device() }, ip)).statusCode;
    expect(last).toBe(429);
  });

  it('shows who is connected: a screen that reports in is connected, one that leaves is not, and one that goes quiet is cleared', async () => {
    const { token, session, guest } = await leadSession();
    const dev = device();
    await call(token, 'POST', `/communications/${session.id}/join`);
    await guestPost('join', { token: linkOf(guest.link), deviceId: dev });
    expect((await call(token, 'POST', `/communications/${session.id}/presence`, { event: 'joined' })).json().participants.filter((p: { connected: boolean }) => p.connected)).toHaveLength(1);
    const snap = (await guestPost('presence', { token: linkOf(guest.link), deviceId: dev, event: 'joined' })).json();
    expect(snap.participants.filter((p: { connected: boolean }) => p.connected)).toHaveLength(2);
    expect(snap).toMatchObject({ status: 'open', removed: false });
    // The guest leaves.
    const left = (await guestPost('presence', { token: linkOf(guest.link), deviceId: dev, event: 'left' })).json();
    expect(left.participants.filter((p: { connected: boolean }) => p.connected)).toHaveLength(1);
    // The staff screen goes quiet: after the window the sweep marks it as gone.
    await owner.query(`UPDATE video_session_invites SET last_seen_at = now() - interval '5 minutes' WHERE session_id = $1 AND kind = 'staff'`, [session.id]);
    expect((await sweep()).lost).toBeGreaterThanOrEqual(1);
    expect((await inviteOf(session.id, 'counsellor')).joined_at).toBeNull();
    const events = (await owner.query(`SELECT event, detail FROM video_session_events WHERE session_id = $1 ORDER BY id`, [session.id])).rows;
    expect(events.map((e) => e.event)).toEqual(expect.arrayContaining(['created', 'invited', 'started', 'accepted', 'joined', 'left']));
    expect(events.some((e) => e.event === 'left' && e.detail === 'connection lost')).toBe(true);
  });

  it('a call everyone has left ends on its own, and a session past its time ends at its time', async () => {
    const a = await leadSession();
    await call(a.token, 'POST', `/communications/${a.session.id}/join`);
    await call(a.token, 'POST', `/communications/${a.session.id}/presence`, { event: 'joined' });
    await call(a.token, 'POST', `/communications/${a.session.id}/presence`, { event: 'left' });
    await owner.query(`UPDATE video_sessions SET started_at = now() - interval '10 minutes' WHERE id = $1`, [a.session.id]);
    await owner.query(`UPDATE video_session_invites SET last_left_at = now() - interval '5 minutes' WHERE session_id = $1`, [a.session.id]);
    const b = await leadSession('counsellor', { maxMinutes: 5 });
    await call(b.token, 'POST', `/communications/${b.session.id}/join`);
    await call(b.token, 'POST', `/communications/${b.session.id}/presence`, { event: 'joined' }); // still connected, so not "empty"
    await owner.query(`UPDATE video_sessions SET started_at = now() - interval '6 minutes' WHERE id = $1`, [b.session.id]);
    const counts = await sweep();
    expect(counts.endedEmpty).toBeGreaterThanOrEqual(1);
    expect(counts.endedTimeUp).toBeGreaterThanOrEqual(1);
    expect(await sessionRow(a.session.id)).toMatchObject({ status: 'ended', outcome: 'completed' });
    expect(await sessionRow(b.session.id)).toMatchObject({ status: 'ended', outcome: 'completed' });
    // Anything nobody ever joined is cancelled once long past.
    const c = await leadSession();
    await owner.query(`UPDATE video_sessions SET created_at = now() - interval '3 days' WHERE id = $1`, [c.session.id]);
    expect((await sweep()).cancelled).toBeGreaterThanOrEqual(1);
    expect(await sessionRow(c.session.id)).toMatchObject({ status: 'ended', outcome: 'cancelled' });
  });

  it('after it is ended nobody can join, and ending again changes nothing', async () => {
    const { token, session, guest } = await leadSession();
    await call(token, 'POST', `/communications/${session.id}/join`);
    const ended = await call(token, 'POST', `/communications/${session.id}/end`);
    expect(ended.json()).toMatchObject({ status: 'ended', outcome: 'completed', phase: 'ended', endedAt: expect.any(String) });
    expect(code(await guestPost('join', { token: linkOf(guest.link), deviceId: device() }))).toBe('SESSION_ENDED');
    expect(code(await call(token, 'POST', `/communications/${session.id}/join`))).toBe('SESSION_ENDED');
    expect((await call(token, 'POST', `/communications/${session.id}/end`)).statusCode).toBe(200);
    const note = await owner.query(`SELECT remark FROM lead_activities WHERE lead_id = $1 AND remark LIKE '%ended after%'`, [session.leadId]);
    expect(note.rows).toHaveLength(1);
  });

  it('a session nobody started is cancelled, not completed', async () => {
    const { token, session } = await leadSession();
    expect((await call(token, 'POST', `/communications/${session.id}/end`)).json().outcome).toBe('cancelled');
  });

  it('a link that expired before anyone joined, and a call past its minutes, are refused', async () => {
    const a = await leadSession();
    await owner.query(`UPDATE video_session_invites SET expires_at = now() - interval '1 minute' WHERE session_id = $1 AND kind = 'guest'`, [a.session.id]);
    expect(code(await guestPost('join', { token: linkOf(a.guest.link), deviceId: device() }))).toBe('LINK_EXPIRED');
    const b = await leadSession('counsellor', { maxMinutes: 10 });
    await owner.query(`UPDATE video_sessions SET started_at = now() - interval '11 minutes' WHERE id = $1`, [b.session.id]);
    expect(code(await guestPost('join', { token: linkOf(b.guest.link), deviceId: device() }))).toBe('SESSION_ENDED');
  });
});

// ================================================================ calls between colleagues

describe('a call to a colleague', () => {
  const callTo = (token: string, who: string, body: Record<string, unknown> = {}) => call(token, 'POST', '/communications/calls', { toUserId: fx.user(who).id, ...body });

  it('rings the colleague, who sees it, accepts and joins', async () => {
    const res = await callTo(t.lc!, 'counsellor2', { kind: 'voice' });
    expect(res.statusCode, res.body).toBe(201);
    const { session, busy } = res.json();
    expect(busy).toBe(false);
    expect(session).toMatchObject({ type: 'call', kind: 'voice', phase: 'ringing' });
    expect(await notes('counsellor2', 'comm_incoming')).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: session.id, fromName: expect.any(String), kind: 'voice' })]));

    const ringing = (await call(t.lc2!, 'GET', '/communications/incoming')).json();
    expect(ringing.map((r: { sessionId: string }) => r.sessionId)).toContain(session.id);
    expect(ringing.find((r: { sessionId: string }) => r.sessionId === session.id)).toMatchObject({ fromName: expect.any(String), kind: 'voice', secondsLeft: expect.any(Number) });

    const accepted = await call(t.lc2!, 'POST', `/communications/${session.id}/respond`, { action: 'accept' });
    expect(accepted.json()).toEqual({ sessionId: session.id, accepted: true });
    expect((await inviteOf(session.id, 'counsellor2')).state).toBe('accepted');
    expect((await call(t.lc2!, 'GET', '/communications/incoming')).json().map((r: { sessionId: string }) => r.sessionId)).not.toContain(session.id);
    const a = (await call(t.lc!, 'POST', `/communications/${session.id}/join`)).json();
    const b = (await call(t.lc2!, 'POST', `/communications/${session.id}/join`)).json();
    expect(a.channel).toBe(b.channel);
    expect(a.uid).not.toBe(b.uid);
  });

  it('turning it down ends it as declined and tells the caller', async () => {
    const { session } = (await callTo(t.lc!, 'mobile')).json();
    expect((await call(t.mobile!, 'POST', `/communications/${session.id}/respond`, { action: 'decline' })).json().accepted).toBe(false);
    expect(await sessionRow(session.id)).toMatchObject({ status: 'ended', outcome: 'declined' });
    expect(await notes('counsellor', 'comm_declined')).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: session.id })]));
    expect(code(await call(t.mobile!, 'POST', `/communications/${session.id}/respond`, { action: 'accept' }))).toBe('SESSION_ENDED');
  });

  it('a call nobody answers becomes a missed call, and the colleague is told', async () => {
    const { session } = (await callTo(t.lc!, 'counsellor2')).json();
    await owner.query(`UPDATE video_session_invites SET invited_at = now() - interval '2 minutes' WHERE session_id = $1 AND user_id = $2`, [session.id, fx.user('counsellor2').id]);
    expect((await sweep()).missed).toBeGreaterThanOrEqual(1);
    expect(await sessionRow(session.id)).toMatchObject({ status: 'ended', outcome: 'missed' });
    expect((await inviteOf(session.id, 'counsellor2')).state).toBe('missed');
    expect(await notes('counsellor2', 'comm_missed')).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: session.id })]));
    expect((await call(t.lc2!, 'GET', '/communications/incoming')).json().map((r: { sessionId: string }) => r.sessionId)).not.toContain(session.id);
  });

  it('answers "busy" at once when the colleague is already in a call', async () => {
    const first = (await callTo(t.lc!, 'counsellor2')).json().session;
    await call(t.lc2!, 'POST', `/communications/${first.id}/respond`, { action: 'accept' });
    await call(t.lc2!, 'POST', `/communications/${first.id}/join`);
    await call(t.lc2!, 'POST', `/communications/${first.id}/presence`, { event: 'joined' });
    const second = (await callTo(t.mobile!, 'counsellor2')).json();
    expect(second.busy).toBe(true);
    expect(second.session).toMatchObject({ status: 'ended', outcome: 'busy' });
    expect((await call(t.mobile!, 'GET', '/communications/colleagues')).json().find((c: { id: string }) => c.id === fx.user('counsellor2').id).busy).toBe(true);
  });

  it('cannot be made to oneself, to someone who cannot take calls, or to someone who does not exist', async () => {
    expect(code(await callTo(t.lc!, 'counsellor'))).toBe('CALL_SELF');
    expect(code(await call(t.lc!, 'POST', '/communications/calls', { toUserId: randomUUID() }))).toBe('CALLEE_UNAVAILABLE');
    expect(code(await callTo(t.lc!, 'inactive'))).toBe('CALLEE_UNAVAILABLE');
  });

  it('only the person called can answer, and a stranger cannot even see it', async () => {
    const { session } = (await callTo(t.lc!, 'counsellor2')).json();
    expect((await call(t.mobile!, 'POST', `/communications/${session.id}/respond`, { action: 'accept' })).statusCode).toBe(404);
    expect((await call(t.lc!, 'POST', `/communications/${session.id}/respond`, { action: 'accept' })).statusCode).toBe(404); // the caller is the host
  });

  it('lists the colleagues who can be called, without the caller', async () => {
    const list = (await call(t.lc!, 'GET', '/communications/colleagues')).json() as { id: string; name: string }[];
    expect(list.map((c) => c.id)).toContain(fx.user('counsellor2').id);
    expect(list.map((c) => c.id)).not.toContain(fx.user('counsellor').id);
    expect(list.map((c) => c.id)).not.toContain(fx.user('inactive').id);
  });
});

// ================================================================ group meetings

describe('a group meeting', () => {
  const meeting = (token: string, body: Record<string, unknown>) => call(token, 'POST', '/communications/meetings', body);
  const inSoon = (min: number) => new Date(Date.now() + min * 60_000).toISOString();

  it('is made with a title, colleagues and guests; each colleague is told and each guest gets a link of their own', async () => {
    const res = await meeting(t.lc!, { title: 'Admission drive review', description: 'Numbers for November', kind: 'video', staffIds: [fx.user('counsellor2').id, fx.user('mobile').id], guests: [{ name: 'Parent One' }, { name: 'Parent Two' }], durationMinutes: 45 });
    expect(res.statusCode, res.body).toBe(201);
    const m = res.json();
    expect(m).toMatchObject({ type: 'meeting', title: 'Admission drive review', description: 'Numbers for November', kind: 'video', maxMinutes: 45, canManage: true });
    expect(m.participants).toHaveLength(5);
    const links = m.participants.filter((p: { kind: string }) => p.kind === 'guest').map((p: { link: string }) => p.link);
    expect(new Set(links).size).toBe(2);
    for (const who of ['counsellor2', 'mobile']) expect(await notes(who, 'comm_meeting_invite')).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: m.id, title: 'Admission drive review' })]));
    expect((await notes('counsellor', 'comm_meeting_invite')).filter((n) => n.sessionId === m.id)).toHaveLength(0);
  });

  it('refuses invitees who are inactive or cannot take part, and more people than the limit allows', async () => {
    expect(code(await meeting(t.lc!, { title: 'x', staffIds: [fx.user('inactive').id] }))).toBe('INVITEE_UNAVAILABLE');
    const guests = Array.from({ length: 17 }, (_, i) => ({ name: `Guest ${i}` })); // with the host, 18 people: one over for video
    expect(code(await meeting(t.lc!, { title: 'Too big', kind: 'video', guests }))).toBe('TOO_MANY_PEOPLE');
    expect((await meeting(t.lc!, { title: 'Big voice', kind: 'voice', guests })).statusCode).toBe(201);
    expect((await meeting(t.lc!, { title: '' })).statusCode).toBe(400);
  });

  it('a planned meeting opens a few minutes before its time, not earlier', async () => {
    const m = (await meeting(t.lc!, { title: 'Later', scheduledFor: inSoon(120), staffIds: [fx.user('counsellor2').id] })).json();
    expect(m.phase).toBe('planned');
    const early = await call(t.lc2!, 'POST', `/communications/${m.id}/join`);
    expect(code(early)).toBe('MEETING_NOT_STARTED');
    const soon = (await meeting(t.lc!, { title: 'Soon', scheduledFor: inSoon(5) })).json();
    expect((await call(t.lc!, 'POST', `/communications/${soon.id}/join`)).statusCode).toBe(200);
  });

  it('reminds the invited colleagues once, shortly before it starts', async () => {
    const m = (await meeting(t.lc!, { title: 'Reminder me', scheduledFor: inSoon(60), staffIds: [fx.user('mobile').id] })).json();
    await owner.query(`UPDATE video_sessions SET scheduled_for = now() + interval '8 minutes' WHERE id = $1`, [m.id]);
    expect((await sweep()).reminders).toBeGreaterThanOrEqual(1);
    expect((await sweep()).reminders).toBe(0); // not again
    expect((await notes('mobile', 'comm_meeting_reminder')).filter((n) => n.sessionId === m.id)).toHaveLength(1);
  });

  it('tells the others when it starts, and when it is ended by the host', async () => {
    const m = (await meeting(t.lc!, { title: 'Live now', staffIds: [fx.user('counsellor2').id] })).json();
    await call(t.lc!, 'POST', `/communications/${m.id}/join`);
    expect((await notes('counsellor2', 'comm_meeting_started')).filter((n) => n.sessionId === m.id)).toHaveLength(1);
    await call(t.lc!, 'POST', `/communications/${m.id}/end`);
    expect((await notes('counsellor2', 'comm_ended')).filter((n) => n.sessionId === m.id)).toHaveLength(1);
  });

  it('more people can be added later, but a one-to-one call stays one-to-one', async () => {
    const m = (await meeting(t.lc!, { title: 'Grow' })).json();
    const added = await call(t.lc!, 'POST', `/communications/${m.id}/invites`, { userId: fx.user('mobile').id });
    expect(added.statusCode, added.body).toBe(201);
    expect(added.json().participants.some((p: { name: string; state: string }) => p.state === 'invited' && p.name)).toBe(true);
    expect(code(await call(t.lc!, 'POST', `/communications/${m.id}/invites`, { userId: fx.user('mobile').id }))).toBe('ALREADY_INVITED');
    expect((await call(t.lc!, 'POST', `/communications/${m.id}/invites`, { guestName: 'A parent' })).json().participants.filter((p: { kind: string }) => p.kind === 'guest')).toHaveLength(1);
    expect((await call(t.lc!, 'POST', `/communications/${m.id}/invites`, { userId: fx.user('mobile').id, guestName: 'both' })).statusCode).toBe(400);
    const { token, session } = await leadSession();
    expect(code(await call(token, 'POST', `/communications/${session.id}/invites`, { guestName: 'third person' }))).toBe('CALL_IS_ONE_TO_ONE');
  });

  it('removing someone cancels their link and sends a screen that is still open out', async () => {
    const m = (await meeting(t.lc!, { title: 'Remove', staffIds: [fx.user('mobile').id], guests: [{ name: 'Guest' }] })).json();
    const guest = m.participants.find((p: { kind: string }) => p.kind === 'guest');
    const staff = m.participants.find((p: { userId: string | null }) => p.userId === fx.user('mobile').id);
    const dev = device();
    await call(t.lc!, 'POST', `/communications/${m.id}/join`);
    await guestPost('join', { token: linkOf(guest.link), deviceId: dev });
    await call(t.mobile!, 'POST', `/communications/${m.id}/join`);

    const gone = await call(t.lc!, 'POST', `/communications/${m.id}/invites/${guest.id}/remove`);
    expect(gone.json().participants.find((p: { id: string }) => p.id === guest.id).state).toBe('removed');
    expect(code(await guestPost('join', { token: linkOf(guest.link), deviceId: dev }))).toBe('NOT_FOUND'); // the link was cancelled: it is no longer a link at all
    expect((await call(t.lc!, 'POST', `/communications/${m.id}/invites/${staff.id}/remove`)).statusCode).toBe(200);
    expect(code(await call(t.mobile!, 'POST', `/communications/${m.id}/join`))).toBe('REMOVED');
    expect((await call(t.mobile!, 'POST', `/communications/${m.id}/presence`, { event: 'ping' })).json().removed).toBe(true);
    const host = m.participants.find((p: { role: string }) => p.role === 'host');
    expect(code(await call(t.lc!, 'POST', `/communications/${m.id}/invites/${host.id}/remove`))).toBe('CANNOT_REMOVE_HOST');
    // Taking a colleague out means they no longer count towards the people limit.
    expect((await call(t.lc!, 'GET', `/communications/${m.id}`)).json().participants.filter((p: { state: string }) => p.state !== 'removed')).toHaveLength(1);
  });

  it('only the host, or an Admin within reach, may end it or take people out', async () => {
    const m = (await meeting(t.lc!, { title: 'Managed', staffIds: [fx.user('counsellor2').id, fx.user('mobile').id] })).json();
    const mobileInvite = m.participants.find((p: { userId: string | null }) => p.userId === fx.user('mobile').id);
    expect(code(await call(t.lc2!, 'POST', `/communications/${m.id}/end`))).toBe('NOT_HOST');
    expect(code(await call(t.lc2!, 'POST', `/communications/${m.id}/invites/${mobileInvite.id}/remove`))).toBe('NOT_HOST');
    expect((await call(t.admin!, 'POST', `/communications/${m.id}/invites/${mobileInvite.id}/remove`)).statusCode).toBe(200); // the counsellor's own Admin
    expect((await call(t.sa!, 'POST', `/communications/${m.id}/end`)).json().status).toBe('ended');
  });

  it('someone who may see a lead\'s call can join it as an observer, and one who may not cannot', async () => {
    const { session } = await leadSession('counsellor');
    expect((await call(t.admin!, 'POST', `/communications/${session.id}/join`)).statusCode).toBe(200);
    expect((await inviteOf(session.id, 'admin')).state).toBe('accepted');
    expect((await call(t.lc2!, 'POST', `/communications/${session.id}/join`)).statusCode).toBe(404);
  });
});

// ================================================================ history

describe('history of calls and meetings', () => {
  it('shows each person what their role allows, and filters', async () => {
    const mine = await leadSession('counsellor', { kind: 'voice' });
    const others = await leadSession('counsellor2', { kind: 'video' });
    const m = (await call(t.lc!, 'POST', '/communications/meetings', { title: 'History meeting', staffIds: [fx.user('mobile').id] })).json();
    await call(mine.token, 'POST', `/communications/${mine.session.id}/join`);
    await call(mine.token, 'POST', `/communications/${mine.session.id}/presence`, { event: 'joined' });
    await call(mine.token, 'POST', `/communications/${mine.session.id}/end`);

    const ids = async (token: string, query = '') => ((await call(token, 'GET', `/communications?limit=100${query}`)).json().items as { id: string }[]).map((i) => i.id);
    const counsellor = await ids(t.lc!);
    expect(counsellor).toEqual(expect.arrayContaining([mine.session.id, m.id]));
    expect(counsellor).not.toContain(others.session.id); // another counsellor's lead
    expect(await ids(t.mobile!)).toContain(m.id); // invited
    expect(await ids(t.mobile!)).not.toContain(mine.session.id);
    expect(await ids(t.admin!)).toContain(mine.session.id); // the Admin of the counsellor
    expect(await ids(t.admin!)).not.toContain(others.session.id); // not their team
    expect(await ids(t.sa!)).toEqual(expect.arrayContaining([mine.session.id, others.session.id, m.id]));

    expect(await ids(t.lc!, '&type=meeting')).toContain(m.id);
    expect(await ids(t.lc!, '&type=meeting')).not.toContain(mine.session.id);
    expect(await ids(t.lc!, '&kind=voice')).toContain(mine.session.id);
    expect(await ids(t.lc!, '&kind=voice')).not.toContain(m.id);
    expect(await ids(t.lc!, '&outcome=completed')).toContain(mine.session.id);
    expect(await ids(t.lc!, '&outcome=open')).toContain(m.id);
    expect(await ids(t.lc!, '&outcome=open')).not.toContain(mine.session.id);
    expect(await ids(t.sa!, `&leadId=${others.lead}`)).toEqual([others.session.id]);
    expect(await ids(t.sa!, `&userId=${fx.user('mobile').id}`)).toContain(m.id);

    const item = ((await call(t.lc!, 'GET', '/communications?limit=100&outcome=completed')).json().items as Record<string, unknown>[]).find((i) => i.id === mine.session.id)!;
    expect(item).toMatchObject({ type: 'call', kind: 'voice', outcome: 'completed', phase: 'ended', leadId: mine.lead, peopleInvited: 2, peopleJoined: 1, recordingStatus: 'not_enabled' });
    expect(item.durationSec).toEqual(expect.any(Number));
    expect(String(item.people)).toContain(',');
  });

  it('pages through with a cursor and never repeats a session', async () => {
    for (let i = 0; i < 3; i++) await leadSession('counsellor');
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = (await call(t.lc!, 'GET', `/communications?limit=2${cursor ? `&cursor=${cursor}` : ''}`)).json() as { items: { id: string }[]; nextCursor: string | null };
      seen.push(...res.items.map((i) => i.id));
      cursor = res.nextCursor;
    } while (cursor);
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('shows one session in full to those who may see it, with what happened and when, and hides it from others', async () => {
    const { token, session } = await leadSession('counsellor');
    await call(token, 'POST', `/communications/${session.id}/join`);
    const full = (await call(token, 'GET', `/communications/${session.id}`)).json();
    expect(full.events.map((e: { event: string }) => e.event)).toEqual(expect.arrayContaining(['created', 'invited', 'started']));
    expect((await call(t.lc2!, 'GET', `/communications/${session.id}`)).statusCode).toBe(404);
    expect((await call(t.sa!, 'GET', `/communications/${session.id}`)).statusCode).toBe(200);
    expect((await call(t.lc!, 'GET', `/communications/${randomUUID()}`)).statusCode).toBe(404);
  });

  it('shows the guests link only to those who may manage the session, not to a colleague who was just invited', async () => {
    const m = (await call(t.lc!, 'POST', '/communications/meetings', { title: 'Links', staffIds: [fx.user('mobile').id], guests: [{ name: 'Parent' }] })).json();
    const asHost = (await call(t.lc!, 'GET', `/communications/${m.id}`)).json();
    expect(asHost.participants.some((p: { link?: string }) => p.link)).toBe(true);
    const asInvitee = (await call(t.mobile!, 'GET', `/communications/${m.id}`)).json();
    expect(asInvitee.canManage).toBe(false);
    expect(asInvitee.participants.some((p: { link?: string }) => p.link)).toBe(false);
    expect(asInvitee.guestUrl).toBeNull();
    expect((await call(t.sa!, 'GET', `/communications/${m.id}`)).json().participants.some((p: { link?: string }) => p.link)).toBe(true); // comm.manage
  });
});

// ================================================================ minutes and the monthly limit

describe('the monthly limit', () => {
  const used = async () => (await call(t.sa!, 'GET', '/communications/usage')).json();
  /** A finished session of `minutes` minutes where `people` different people connected, written straight into the database. */
  async function finished(lead: string, kind: 'video' | 'voice', minutes: number, people: number) {
    const res = await call(t.lc!, 'POST', `/leads/${lead}/communications`, { kind, maxMinutes: Math.max(minutes, 5) });
    const s = res.json();
    await owner.query(`UPDATE video_sessions SET started_at = now() - make_interval(mins => $2 + 10), status = 'ended', outcome = 'completed', ended_at = now() - interval '10 minutes' WHERE id = $1`, [s.id, minutes]);
    // The host and the lead connected; `people - 2` more connected as well.
    await owner.query(`UPDATE video_session_invites SET first_joined_at = now() WHERE session_id = $1`, [s.id]);
    for (let i = 0; i < people - 2; i++) {
      await owner.query(`INSERT INTO video_session_invites (tenant_id, session_id, kind, guest_name, state, agora_uid, expires_at, invited_by, first_joined_at) VALUES ($1, $2, 'guest', $3, 'accepted', $4, now() + interval '1 day', $5, now())`,
        [fx.tenantId, s.id, `Extra ${i}`, 1000 + i, fx.user('counsellor').id]);
    }
    return s;
  }

  it('counts Agora Standard minutes: a voice call costs a quarter of a video call, and each extra person adds to it', async () => {
    const lead = await leadOf('counsellor');
    const before = await used();
    expect(before).toMatchObject({ limitStandardMinutes: 9000 });
    await finished(lead, 'video', 30, 2);
    const afterVideo = await used();
    expect(afterVideo.usedStandardMinutes - before.usedStandardMinutes).toBe(240); // 30 min x 2 people x 4
    await finished(lead, 'voice', 30, 2);
    const afterVoice = await used();
    expect(afterVoice.usedStandardMinutes - afterVideo.usedStandardMinutes).toBe(60); // x 1
    await finished(lead, 'video', 30, 4);
    expect((await used()).usedStandardMinutes - afterVoice.usedStandardMinutes).toBe(480); // 30 x 4 people x 4
  });

  it('says how many minutes of video or of voice the rest of the allowance buys', async () => {
    const u = await used();
    const left = 9000 - u.usedStandardMinutes;
    expect(u.videoMinutesLeft).toBe(Math.floor(left / 8));
    expect(u.voiceMinutesLeft).toBe(Math.floor(left / 2));
  });

  it('stops a new session that would go past the limit, voice sessions last', async () => {
    const lead = await leadOf('counsellor');
    const video = (await call(t.lc!, 'POST', `/leads/${lead}/communications`, { maxMinutes: 60 })).json();
    const voice = (await call(t.lc!, 'POST', `/leads/${lead}/communications`, { kind: 'voice', maxMinutes: 5 })).json();
    const now = (await used()).usedStandardMinutes;
    // Fill the month up to 100 Standard minutes short of the limit with finished voice sessions (480 each).
    const fillers = Math.floor((9000 - 100 - now) / 480);
    await owner.query(`INSERT INTO video_sessions (tenant_id, lead_id, created_by, expires_at, max_minutes, kind, status, outcome, started_at, ended_at)
                       SELECT $1, $2, $3, now() + interval '1 day', 240, 'voice', 'ended', 'completed', now() - interval '5 hours', now() - interval '1 hour' FROM generate_series(1, $4::int)`,
      [fx.tenantId, lead, fx.user('counsellor').id, fillers]);
    const top = 9000 - 100 - (await used()).usedStandardMinutes;
    if (top > 0) {
      await owner.query(`INSERT INTO video_sessions (tenant_id, lead_id, created_by, expires_at, max_minutes, kind, status, outcome, started_at, ended_at)
                         VALUES ($1, $2, $3, now() + interval '1 day', 240, 'voice', 'ended', 'completed', now() - interval '5 hours', now() - interval '5 hours' + make_interval(mins => $4))`,
        [fx.tenantId, lead, fx.user('counsellor').id, Math.floor(top / 2)]);
    }
    const res = await call(t.lc!, 'POST', `/communications/${video.id}/join`);
    expect(res.statusCode, res.body).toBe(409);
    expect(code(res)).toBe('VIDEO_LIMIT_REACHED');
    const link = video.participants.find((p: { kind: string }) => p.kind === 'guest').link as string;
    expect(code(await guestPost('join', { token: linkOf(link), deviceId: device() }))).toBe('VIDEO_LIMIT_REACHED');
    expect((await call(t.lc!, 'POST', `/communications/${voice.id}/join`)).statusCode).toBe(200);
  });
});

// ================================================================ set-up

describe('when calls are not set up', () => {
  it('says so clearly instead of failing', async () => {
    const bare = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500', AGORA_APP_ID: '', AGORA_APP_CERTIFICATE: '' });
    try {
      const c = makeClient(bare, fx);
      const token = await c.signIn('super');
      expect((await c.call('GET', '/communications/status', token)).json()).toEqual({ enabled: false });
      const lead = await leadOf('counsellor');
      const res = await c.call('POST', `/leads/${lead}/communications`, token, {});
      expect(res.statusCode).toBe(409);
      expect(code(res)).toBe('VIDEO_NOT_CONFIGURED');
    } finally {
      await bare.close();
    }
  });

  it('reports that it is enabled when the credentials are present', async () => {
    expect((await call(t.sa!, 'GET', '/communications/status')).json()).toEqual({ enabled: true });
  });
});
