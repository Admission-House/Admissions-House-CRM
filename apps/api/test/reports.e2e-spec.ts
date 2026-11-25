import { parse } from 'csv-parse/sync';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { readSheet } from 'read-excel-file/node';
import { startApp } from './helpers/app.js';
import { Client, makeClient } from './helpers/client.js';
import { createFixture, Fixture } from './helpers/fixtures.js';

let app: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;
let api: Client;
const t: Record<string, string> = {};
let tatLead = '';
const MONTH = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7); // the company's own month, not UTC

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  app = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500' });
  api = makeClient(app, fx);
  t.sa = await api.signIn('super');
  for (const name of ['admin', 'admin2', 'lc1', 'lc2']) t[name] = await api.signIn(name, { office: true });
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.end();
});

let counter = 0;
const phone = () => `9${String(300_000_000 + ++counter).padStart(9, '0')}`;
const errorCode = (res: { json: () => { error?: { code?: string } } }) => res.json().error?.code;
const newLead = async (token: string, name: string, source: 'Website' | 'Meta Ads' = 'Website') => {
  const res = await api.call('POST', '/leads', token, { name, phone: phone(), sourceId: fx.sourceId(source) });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
};
const insertCall = (who: string, leadId: string | null, o: { direction?: string; outcome?: string; startedAgo?: string; secs?: number; ended?: boolean } = {}) =>
  owner.query(
    `INSERT INTO calls (tenant_id, lead_id, user_id, direction, provider_call_id, counterparty, started_at, outcome, duration_sec, ended_at)
     VALUES ($1, $2, $3, $4, $5, '919800000001', now() - $6::interval, $7, $8, CASE WHEN $9 THEN now() - $6::interval + interval '1 minute' END)`,
    [fx.tenantId, leadId, fx.user(who).id, o.direction ?? 'outgoing', `rep-${++counter}`, o.startedAgo ?? '5 minutes', o.outcome ?? 'connected', o.secs ?? 0, o.ended ?? true],
  );
const row = (r: { json: () => { rows: Record<string, unknown>[] } }, key: string, value: unknown) => r.json().rows.find((x) => x[key] === value);

beforeAll(async () => {
  // a lead whose first call came ten minutes after it arrived (all within the last quarter hour, so the tests also pass just after midnight)
  tatLead = await newLead(t.lc1!, 'Tat Lead', 'Meta Ads');
  await owner.query(`UPDATE leads SET created_at = now() - interval '14 minutes' WHERE id = $1`, [tatLead]);
  await insertCall('lc1', tatLead, { startedAgo: '4 minutes', secs: 120 });
  await insertCall('lc1', tatLead, { startedAgo: '3 minutes', secs: 60 });
  await insertCall('lc1', null, { direction: 'incoming', outcome: 'missed', startedAgo: '2 minutes', ended: true });
  await insertCall('lc2', await newLead(t.lc2!, 'Lc2 Lead'), { outcome: 'not_picked', startedAgo: '1 minute' });
  // work done: a status change and a completed follow-up
  const contacted = (await owner.query(`SELECT id FROM lead_statuses WHERE tenant_id = $1 AND name = 'Contacted'`, [fx.tenantId])).rows[0].id;
  expect((await api.call('POST', `/leads/${tatLead}/status`, t.lc1!, { statusId: contacted, remark: 'Spoke' })).statusCode).toBe(200);
  const fu = await api.call('POST', `/leads/${tatLead}/followups`, t.lc1!, { dueAt: new Date(Date.now() + 3_600_000).toISOString(), note: 'x' });
  expect(fu.statusCode, fu.body).toBe(201);
  expect((await api.call('POST', `/followups/${fu.json().id}/done`, t.lc1!, {})).statusCode).toBeLessThan(300);
});

describe('dashboard', () => {
  it('shows a counsellor their own numbers and no team', async () => {
    const d = (await api.call('GET', '/dashboard', t.lc1!)).json();
    expect(d.team).toBeNull();
    expect(d.total).toBeGreaterThanOrEqual(1);
    expect(d.byStatus.some((s: { status: string }) => s.status === 'Contacted')).toBe(true);
    expect(d.today.calls).toMatchObject({ total: 3, connected: 2, missed: 1, talkSec: 180 });
    expect(d.today).toHaveProperty('overdueFollowUps');
  });

  it('shows an Admin their team\'s calls and the team, a stranger nothing', async () => {
    const d = (await api.call('GET', '/dashboard', t.admin!)).json();
    expect(d.today.calls.total).toBe(4);
    expect(d.team.map((m: { name: string }) => m.name)).toEqual(expect.arrayContaining(['lc1', 'lc2']));
    expect((await api.call('GET', '/dashboard', t.admin2!)).json().today.calls.total).toBe(0);
  });
});

describe('team status', () => {
  it('tells who is signed in, on a call, idle or not here', async () => {
    await insertCall('lc1', tatLead, { outcome: 'connected', startedAgo: '2 minutes', ended: false }); // still talking
    await owner.query(`UPDATE user_sessions SET last_active_at = now() - interval '30 minutes' WHERE user_id = $1 AND ended_at IS NULL`, [fx.user('lc2').id]);
    const res = await api.call('GET', '/reports/team-status', t.admin!);
    const byName = Object.fromEntries(res.json().rows.map((r: { name: string; status: string }) => [r.name, r.status]));
    expect(byName.lc1).toBe('on_call');
    expect(byName.lc2).toBe('idle');
    expect(byName.lc3).toBe('not_logged_in');
    expect(byName.admin).toBe('online');
    await owner.query(`UPDATE calls SET outcome = 'failed' WHERE tenant_id = $1 AND ended_at IS NULL`, [fx.tenantId]);
  });

  it('shows a counsellor only themselves', async () => {
    expect((await api.call('GET', '/reports/team-status', t.lc1!)).json().rows.map((r: { name: string }) => r.name)).toEqual(['lc1']);
  });
});

describe('turn-around time', () => {
  it('measures arrival to first call, by counsellor and by source', async () => {
    const byUser = await api.call('GET', '/reports/tat?groupBy=user', t.admin!);
    expect(byUser.statusCode, byUser.body).toBe(200);
    expect(row(byUser, 'name', 'lc1')).toMatchObject({ leads: 1, called: 1, notCalled: 0, avgMin: 10, medianMin: 10 });
    expect(row(byUser, 'name', 'lc2')).toMatchObject({ leads: 1, called: 0, notCalled: 1, avgMin: null });
    const bySource = await api.call('GET', '/reports/tat?groupBy=source', t.admin!);
    expect(row(bySource, 'name', 'Meta Ads')).toMatchObject({ leads: 1, called: 1, avgMin: 10 });
    expect(row(bySource, 'name', 'Website')).toMatchObject({ leads: 1, called: 0 });
  });
});

describe('productivity and activity', () => {
  it('counts calls, talk time, status changes and follow-ups for each person and day', async () => {
    const res = await api.call('GET', '/reports/productivity', t.admin!);
    const lc1 = row(res, 'name', 'lc1')!;
    expect(lc1).toMatchObject({ calls: 4, connected: 2, talkSec: 180, statusChanges: 1, followUpsDone: 1 });
    const today = (await owner.query(`SELECT (now() AT TIME ZONE timezone)::date::text AS d FROM tenants WHERE id = $1`, [fx.tenantId])).rows[0].d; // the company's own day, not UTC
    expect(lc1.day).toBe(today);
    expect(row(res, 'name', 'lc2')).toMatchObject({ calls: 1, connected: 0 });
    expect(res.json().columns.length).toBe(7);
  });

  it('follows scope and the user filter', async () => {
    expect((await api.call('GET', '/reports/productivity', t.lc1!)).json().rows.every((r: { name: string }) => r.name === 'lc1')).toBe(true);
    expect((await api.call('GET', '/reports/productivity', t.admin2!)).json().rows).toEqual([]);
    const one = await api.call('GET', `/reports/productivity?userId=${fx.user('lc2').id}`, t.admin!);
    expect(one.json().rows.every((r: { name: string }) => r.name === 'lc2')).toBe(true);
  });

  it('counts what each person did, by kind', async () => {
    const res = await api.call('GET', '/reports/activity', t.admin!);
    const lc1 = row(res, 'name', 'lc1')!;
    expect(lc1.statusChanges).toBe(1);
    expect(Number(lc1.total)).toBeGreaterThanOrEqual(2);
    t.lc2 = await api.signIn('lc2', { office: true }); // the earlier status test left this session idle
    const mine = await api.call('GET', '/reports/activity', t.lc2!);
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.json().rows.every((r: { name: string }) => r.name === 'lc2')).toBe(true);
  });
});

describe('lead and call reports', () => {
  it('groups leads by source, status, counsellor and day', async () => {
    const src = await api.call('GET', '/reports/leads?groupBy=source', t.admin!);
    expect(row(src, 'name', 'Meta Ads')).toMatchObject({ leads: 1, open: 1 });
    const st = await api.call('GET', '/reports/leads?groupBy=status', t.admin!);
    expect(row(st, 'name', 'Contacted')).toMatchObject({ leads: 1 });
    expect(row(st, 'name', 'New')).toMatchObject({ leads: 1 });
    expect(row(await api.call('GET', '/reports/leads?groupBy=assignee', t.admin!), 'name', 'lc1')).toMatchObject({ leads: 1 });
    const day = await api.call('GET', '/reports/leads?groupBy=day', t.admin!);
    expect(day.json().rows.reduce((n: number, r: { leads: number }) => n + r.leads, 0)).toBe(2);
    expect((await api.call('GET', '/reports/leads', t.admin2!)).json().rows).toEqual([]);
  });

  it('summarises call activity per counsellor', async () => {
    const res = await api.call('GET', '/reports/calls', t.admin!);
    expect(row(res, 'name', 'lc1')).toMatchObject({ total: 4, outgoing: 3, incoming: 1, connected: 2, missed: 1 });
    expect(row(res, 'name', 'lc2')).toMatchObject({ total: 1, connected: 0, avgSec: null });
    expect(row(res, 'name', 'lc1')!.avgSec).toBe(90);
  });

  it('summarises attendance for a month', async () => {
    const res = await api.call('GET', `/reports/attendance?month=${MONTH}`, t.admin!);
    expect(res.statusCode, res.body).toBe(200);
    const lc1 = row(res, 'name', 'lc1')!;
    expect(Number(lc1.present)).toBeGreaterThanOrEqual(1);
    expect(lc1.absent).toBe(Math.max(0, Number(lc1.workingDays) - Number(lc1.present) - Number(lc1.leaveDays)));
    expect(row(res, 'name', 'super')).toBeUndefined(); // Super Admins are not tracked
    expect(errorCode(await api.call('GET', '/reports/attendance?month=nope', t.admin!))).toBe('MONTH_INVALID');
  });

  it('shows who was in on each day of the month', async () => {
    const res = await api.call('GET', `/reports/attendance-days?month=${MONTH}`, t.admin!);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    const last = Number(new Date(Date.UTC(Number(MONTH.slice(0, 4)), Number(MONTH.slice(5, 7)), 0)).getUTCDate());
    expect(body.columns.length).toBe(2 + last); // name, role, one column per day
    const lc1 = row(res, 'name', 'lc1')!;
    const letters = Object.entries(lc1).filter(([k]) => /^d[0-9]+$/.test(k)).map(([, v]) => v);
    expect(letters.some((v) => v === 'P' || v === 'L')).toBe(true); // signed in today
    expect(letters.every((v) => ['P', 'L', 'V', 'O', 'A', ''].includes(String(v)))).toBe(true);
    expect(row(res, 'name', 'super')).toBeUndefined();
    expect(errorCode(await api.call('GET', '/reports/attendance-days?month=nope', t.admin!))).toBe('MONTH_INVALID');
  });

  it('does not count the days before a person joined as absent', async () => {
    // lc2 joins today: every earlier day of the month is blank in the grid and is not a working day in the summary.
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const before = await owner.query(`SELECT joined_on FROM users WHERE id = $1`, [fx.user('lc2').id]);
    await owner.query(`UPDATE users SET joined_on = $2::date WHERE id = $1`, [fx.user('lc2').id, today]);
    try {
      const grid = row(await api.call('GET', `/reports/attendance-days?month=${MONTH}`, t.admin!), 'name', 'lc2')!;
      const day = Number(today.slice(8));
      for (let d = 1; d < day; d++) expect(grid[`d${d}`], `day ${d}`).toBe('');
      const sum = row(await api.call('GET', `/reports/attendance?month=${MONTH}`, t.admin!), 'name', 'lc2')!;
      expect(Number(sum.workingDays)).toBeLessThanOrEqual(1);
      expect(Number(sum.absent)).toBeLessThanOrEqual(1);
    } finally {
      await owner.query(`UPDATE users SET joined_on = $2 WHERE id = $1`, [fx.user('lc2').id, before.rows[0].joined_on]);
    }
  });
});

describe('dates, files and permissions', () => {
  it('keeps to the date range, in the company\'s days', async () => {
    const day = (ago: number) => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);
    expect((await api.call('GET', `/reports/calls?from=${day(40)}&to=${day(35)}`, t.admin!)).json().rows).toEqual([]);
    expect(errorCode(await api.call('GET', '/reports/calls?from=2026-02-02&to=2026-02-01', t.admin!))).toBe('RANGE_INVALID');
    expect(errorCode(await api.call('GET', '/reports/calls?from=2024-01-01&to=2026-01-01', t.admin!))).toBe('RANGE_TOO_LONG');
    expect(errorCode(await api.call('GET', '/reports/calls?from=yesterday', t.admin!))).toBe('VALIDATION_FAILED');
  });

  it('exports to CSV and Excel for people who may export, formula-safe', async () => {
    await owner.query(`UPDATE users SET name = '=cmd|calc' WHERE id = $1`, [fx.user('lc2').id]);
    const csv = await api.call('GET', '/reports/calls?format=csv', t.admin!);
    expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(csv.headers['content-disposition']).toMatch(/call-activity-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv/);
    const rows = parse(csv.body, { bom: true, columns: true }) as Record<string, string>[];
    expect(rows.map((r) => r.Counsellor)).toContain("'=cmd|calc");
    await owner.query(`UPDATE users SET name = 'lc2' WHERE id = $1`, [fx.user('lc2').id]);

    const x = await app.inject({ method: 'GET', url: '/api/v1/reports/calls?format=xlsx', headers: { authorization: `Bearer ${t.admin}` } });
    expect(x.statusCode).toBe(200);
    expect((await readSheet(x.rawPayload))[0]).toContain('Talk time (seconds)');
    expect((await api.call('GET', '/reports/calls?format=csv', t.lc1!)).statusCode).toBe(403); // may look, may not export
    expect((await api.call('GET', '/reports/calls', t.lc1!)).statusCode).toBe(200);
  });

  it('needs sign-in and the permission', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/dashboard' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/reports/calls' })).statusCode).toBe(401);
  });
});

describe('in-app voice calls with a lead', () => {
  /** A voice (or video) call written straight into the database, as the CRM's Agora calls are stored. */
  const session = async (who: string, leadId: string | null, o: { kind?: 'voice' | 'video'; startedAgo: string; guestJoinedAgo?: string; endedAgo?: string }) => {
    const { rows } = await owner.query(
      `INSERT INTO video_sessions (tenant_id, lead_id, created_by, expires_at, kind, status, outcome, created_at, started_at, ended_at)
       VALUES ($1, $2, $3, now() + interval '1 day', $4, CASE WHEN $6::interval IS NULL THEN 'open' ELSE 'ended' END,
               CASE WHEN $6::interval IS NULL THEN NULL WHEN $7::interval IS NULL THEN 'missed' ELSE 'completed' END,
               now() - $5::interval, now() - $5::interval, now() - $6::interval)
       RETURNING id`,
      [fx.tenantId, leadId, fx.user(who).id, o.kind ?? 'voice', o.startedAgo, o.endedAgo ?? null, o.guestJoinedAgo ?? null],
    );
    await owner.query(
      `INSERT INTO video_session_invites (tenant_id, session_id, kind, guest_name, state, agora_uid, expires_at, invited_by, first_joined_at)
       VALUES ($1, $2, 'guest', 'Student', $3, $4, now() + interval '1 day', $5, now() - $6::interval)`,
      [fx.tenantId, rows[0].id, o.guestJoinedAgo ? 'accepted' : 'invited', 5000 + ++counter, fx.user(who).id, o.guestJoinedAgo ?? null],
    );
    return rows[0].id as string;
  };
  type Counts = { total: number; connected: number; outgoing: number; talkSec: number; app: number };
  const callsOf = async (who: string) => row(await api.call('GET', '/reports/calls', t.admin!), 'name', who) as Counts | undefined;

  it('are listed in the call history with the phone calls, so the list matches the dashboard count', async () => {
    const lead = await newLead(t.lc1!, 'History Voice Lead');
    const talked = await session('lc1', lead, { startedAgo: '4 minutes', guestJoinedAgo: '3 minutes', endedAgo: '1 minute' });
    const unanswered = await session('lc1', lead, { startedAgo: '2 minutes', endedAgo: '1 minute' });
    await session('lc1', lead, { kind: 'video', startedAgo: '1 minute', guestJoinedAgo: '1 minute', endedAgo: '30 seconds' }); // video: not listed

    const forLead = (await api.call('GET', `/leads/${lead}/calls?limit=50`, t.lc1!)).json().items as { id: string; via: string; outcome: string; number: string; wrappedUp: boolean; recording: string }[];
    expect(forLead.map((c) => c.id).sort()).toEqual([talked, unanswered].sort());
    const one = forLead.find((c) => c.id === talked)!;
    expect(one).toMatchObject({ via: 'app', outcome: 'connected', wrappedUp: false, recording: 'none' });
    expect(one.number).toMatch(/^91\d{10}$/);
    expect(forLead.find((c) => c.id === unanswered)!.outcome).toBe('not_picked');

    // The call history shows them too; an in-app call has no after-call form, so it is not "waiting for the form".
    const all = (await api.call('GET', `/calls?limit=100&userId=${fx.user('lc1').id}`, t.admin!)).json().items as { id: string }[];
    expect(all.map((c) => c.id)).toEqual(expect.arrayContaining([talked, unanswered]));
    const waiting = (await api.call('GET', '/calls?limit=100&unwrapped=true', t.admin!)).json().items as { id: string }[];
    expect(waiting.map((c) => c.id)).not.toContain(talked);

    // Today's list for one person has as many calls as their dashboard counts.
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const listed = (await api.call('GET', `/calls?limit=100&from=${today}&to=${today}`, t.lc1!)).json().items.length;
    expect(listed).toBe((await api.call('GET', '/dashboard', t.lc1!)).json().today.calls.total);
  });

  it('are counted with the phone calls: connected only when the student joined, talk time from then to the end', async () => {
    const before = (await callsOf('lc2')) ?? { total: 0, connected: 0, outgoing: 0, talkSec: 0, app: 0 };
    const dashBefore = (await api.call('GET', '/dashboard', t.lc2!)).json().today.calls;
    const lead = await newLead(t.lc2!, 'Voice Lead');
    expect((await owner.query(`SELECT first_called_at FROM leads WHERE id = $1`, [lead])).rows[0].first_called_at).toBeNull();

    await session('lc2', lead, { startedAgo: '6 minutes', guestJoinedAgo: '5 minutes', endedAgo: '2 minutes' }); // talked 3 minutes
    await session('lc2', lead, { startedAgo: '90 seconds', endedAgo: '1 minute' }); // the student did not join
    await session('lc2', lead, { kind: 'video', startedAgo: '1 minute', guestJoinedAgo: '1 minute', endedAgo: '30 seconds' }); // video: not a phone-style call
    await session('lc2', null, { startedAgo: '1 minute', guestJoinedAgo: '1 minute', endedAgo: '30 seconds' }); // no lead: a colleague, not a student

    const after = (await callsOf('lc2'))!;
    expect(after.total - before.total).toBe(2);
    expect(after.outgoing - before.outgoing).toBe(2);
    expect(after.connected - before.connected).toBe(1);
    expect(after.app - before.app).toBe(2);
    expect(after.talkSec - before.talkSec).toBe(180);

    const dash = (await api.call('GET', '/dashboard', t.lc2!)).json().today.calls;
    expect(dash.total - dashBefore.total).toBe(2);
    expect(dash.connected - dashBefore.connected).toBe(1);
    expect(dash.missed).toBe(dashBefore.missed); // an unanswered outgoing call is not a missed incoming one

    // "First called" is the first of them, and a later call does not move it.
    const first = (await owner.query(`SELECT first_called_at FROM leads WHERE id = $1`, [lead])).rows[0].first_called_at as Date;
    const sixAgo = Date.now() - 6 * 60_000;
    expect(Math.abs(first.getTime() - sixAgo)).toBeLessThan(30_000);
  });

  it('show a counsellor on a voice call as on a call', async () => {
    const lead = await newLead(t.lc2!, 'Talking Lead');
    const id = await session('lc2', lead, { startedAgo: '2 minutes', guestJoinedAgo: '1 minute' }); // still going
    const byName = Object.fromEntries((await api.call('GET', '/reports/team-status', t.admin!)).json().rows.map((r: { name: string; status: string }) => [r.name, r.status]));
    expect(byName.lc2).toBe('on_call');
    await owner.query(`UPDATE video_sessions SET status = 'ended', outcome = 'completed', ended_at = now() WHERE id = $1`, [id]);
  });

  it('fill in "First called" for a phone call too', async () => {
    const lead = await newLead(t.lc1!, 'Phone Lead');
    await insertCall('lc1', lead, { startedAgo: '30 seconds', outcome: 'not_picked' });
    expect((await owner.query(`SELECT first_called_at FROM leads WHERE id = $1`, [lead])).rows[0].first_called_at).not.toBeNull();
    // An incoming call is not "called".
    const other = await newLead(t.lc1!, 'Rang Us');
    await insertCall('lc1', other, { direction: 'incoming', outcome: 'missed', startedAgo: '10 seconds' });
    expect((await owner.query(`SELECT first_called_at FROM leads WHERE id = $1`, [other])).rows[0].first_called_at).toBeNull();
  });
});
