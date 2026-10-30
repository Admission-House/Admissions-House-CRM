import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { IdleSweepService } from '../src/attendance/idle-sweep.service.js';
import { startApp } from './helpers/app.js';
import { Client, inOffice, makeClient } from './helpers/client.js';
import { createFixture, Fixture, OFFICE_IP } from './helpers/fixtures.js';

let app: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;
let api: Client;
let sweep: IdleSweepService;
let sa: string;
let admin: string;

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  app = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500' });
  api = makeClient(app, fx);
  sweep = app.get(IdleSweepService);
  sa = await api.signIn('super');
  admin = await api.signIn('admin', { office: true });
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.end();
});

// ------------------------------------------------------------------ helpers

const errorCode = (res: { json: () => { error?: { code?: string } } }) => res.json().error?.code;

/** The company's own date, as the code sees it. */
const localDate = async (offsetDays = 0) =>
  (await owner.query(`SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date + $1::int)::text AS d`, [offsetDays])).rows[0].d as string;

/** Sets the working rules for today, replacing any rows the tests added. */
async function useSettings(opts: { start?: string; end?: string; grace?: number; idle?: number } = {}) {
  await owner.query(`DELETE FROM attendance_settings WHERE tenant_id = $1 AND effective_from > CURRENT_DATE - 20`, [fx.tenantId]);
  await owner.query(
    `UPDATE attendance_settings SET shift_start = $2, shift_end = $3, grace_minutes = $4, idle_timeout_min = $5, weekly_off_days = '{0}'
     WHERE tenant_id = $1`,
    [fx.tenantId, opts.start ?? '10:00', opts.end ?? '19:00', opts.grace ?? 10, opts.idle ?? 30],
  );
}

const officeLogin = (name: string) => api.login({ ...api.credentials(name), location: inOffice }, OFFICE_IP);
async function checkIn(name: string): Promise<string> {
  const res = await officeLogin(name);
  expect(res.statusCode, `${name}: ${res.body}`).toBe(200);
  return res.json().accessToken;
}

const records = async (name: string) =>
  (
    await owner.query(
      `SELECT id, work_date::text AS work_date, check_in_at, check_out_at, check_out_reason, late_minutes, method,
              branch_id, check_in_ip::text AS ip, check_in_lat::float8 AS lat, check_in_lng::float8 AS lng
       FROM attendance_records WHERE user_id = $1 ORDER BY work_date DESC`,
      [fx.user(name).id],
    )
  ).rows;

const ageSession = (name: string, minutes: number) =>
  owner.query(`UPDATE user_sessions SET last_active_at = now() - make_interval(mins => $2) WHERE user_id = $1 AND ended_at IS NULL`, [fx.user(name).id, minutes]);

// ------------------------------------------------------------ checking in

describe('attendance starts when someone signs in from the office', () => {
  beforeEach(() => useSettings());

  it('records the check-in with where it happened', async () => {
    await checkIn('att1');
    const [r, ...rest] = await records('att1');
    expect(rest).toHaveLength(0);
    expect(r).toMatchObject({ work_date: await localDate(), method: 'office_check', branch_id: fx.branchId, ip: `${OFFICE_IP}/32`, lat: inOffice.lat, lng: inOffice.lng, check_out_at: null });
  });

  it('marks someone late after the shift start plus the grace period, counting from the shift start', async () => {
    await useSettings({ start: '00:00', grace: 0 });
    await checkIn('att2');
    const minutesSinceMidnight = Number(
      (await owner.query(`SELECT floor(EXTRACT(EPOCH FROM (now() AT TIME ZONE 'Asia/Kolkata')::time) / 60)::int AS m`)).rows[0].m,
    );
    const [r] = await records('att2');
    expect(Math.abs(r.late_minutes - minutesSinceMidnight)).toBeLessThanOrEqual(2);
  });

  it('does not mark someone late who arrives within the grace period or early', async () => {
    await useSettings({ start: '23:55', grace: 0 });
    await checkIn('att3');
    expect((await records('att3'))[0].late_minutes).toBe(0);
  });

  it('keeps one record a day: signing in again after signing out reopens it and keeps the first arrival', async () => {
    await useSettings({ start: '00:00', grace: 0 });
    const token = await checkIn('att4');
    const first = (await records('att4'))[0];

    await api.call('POST', '/auth/logout', token, undefined, OFFICE_IP);
    const closed = (await records('att4'))[0];
    expect(closed.check_out_at).not.toBeNull();
    expect(closed.check_out_reason).toBe('manual');

    await checkIn('att4');
    const all = await records('att4');
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: first.id, check_out_at: null, check_out_reason: null, late_minutes: first.late_minutes });
    expect(all[0].check_in_at).toEqual(first.check_in_at);
  });

  it('does not record attendance for a Super Admin, who can sign in from anywhere', async () => {
    const res = await api.call('GET', '/attendance/me/today', sa);
    expect(res.json()).toEqual({ tracked: false });
    const count = (await owner.query(`SELECT count(*)::int AS n FROM attendance_records WHERE user_id = $1`, [fx.user('super').id])).rows[0].n;
    expect(count).toBe(0);
  });

  it('does not check in someone whose sign-in is refused', async () => {
    const res = await api.login({ ...api.credentials('att5'), location: { ...inOffice, lat: inOffice.lat + 0.05 } }, OFFICE_IP);
    expect(errorCode(res)).toBe('OUTSIDE_OFFICE');
    expect(await records('att5')).toHaveLength(0);
  });

  it('tells every Super Admin about a refused office sign-in, once for repeated tries', async () => {
    const tryOutside = () => api.login({ ...api.credentials('att6'), location: { ...inOffice, lat: inOffice.lat + 0.05 } }, OFFICE_IP);
    expect(errorCode(await tryOutside())).toBe('OUTSIDE_OFFICE');
    expect(errorCode(await tryOutside())).toBe('OUTSIDE_OFFICE');
    const superAdmins = Number((await owner.query(`SELECT count(*) FROM users u JOIN roles r ON r.id = u.role_id WHERE u.tenant_id = $1 AND r.system_key = 'super_admin' AND u.status = 'active'`, [fx.tenantId])).rows[0].count);
    const alerts = (await owner.query(`SELECT user_id, type, payload FROM notifications WHERE tenant_id = $1 AND payload->>'event' = 'login_refused' AND payload->>'userName' = 'att6'`, [fx.tenantId])).rows;
    expect(alerts).toHaveLength(superAdmins);
    expect(alerts[0]).toMatchObject({ type: 'security', payload: { event: 'login_refused', userName: 'att6' } });
  });
});

describe('checking out follows the last session', () => {
  beforeEach(() => useSettings());

  it('waits until every session of the person has ended', async () => {
    const first = await checkIn('att6');
    const second = await checkIn('att6');

    await api.call('POST', '/auth/logout', first, undefined, OFFICE_IP);
    expect((await records('att6'))[0].check_out_at).toBeNull();

    await api.call('POST', '/auth/logout', second, undefined, OFFICE_IP);
    expect((await records('att6'))[0]).toMatchObject({ check_out_reason: 'manual' });
    expect((await records('att6'))[0].check_out_at).not.toBeNull();
  });

  it('checks someone out when an Admin signs them out everywhere', async () => {
    await checkIn('att7');
    await api.call('POST', `/users/${fx.user('att7').id}/reset-password`, sa);
    expect((await records('att7'))[0].check_out_reason).toBe('forced');
  });
});

// ------------------------------------------------------------- idle sweep

describe('the idle sweep', () => {
  beforeEach(() => useSettings());

  const notificationsAbout = async (name: string) =>
    (
      await owner.query(
        `SELECT user_id, type, payload FROM notifications WHERE tenant_id = $1 AND payload->>'userName' = $2`,
        [fx.tenantId, name],
      )
    ).rows;

  it('signs out someone quiet for 30 minutes, checks them out and tells every Super Admin', async () => {
    await checkIn('att8');
    await ageSession('att8', 31);

    const result = await sweep.sweepOnce();
    expect(result.idleEnded).toBeGreaterThanOrEqual(1);

    expect((await records('att8'))[0]).toMatchObject({ check_out_reason: 'inactivity' });
    const session = (await owner.query(`SELECT ended_reason FROM user_sessions WHERE user_id = $1`, [fx.user('att8').id])).rows[0];
    expect(session.ended_reason).toBe('inactivity');

    const activeSuperAdmins = Number(
      (await owner.query(
        `SELECT count(*) FROM users u JOIN roles r ON r.id = u.role_id WHERE u.tenant_id = $1 AND r.system_key = 'super_admin' AND u.status = 'active'`,
        [fx.tenantId],
      )).rows[0].count,
    );
    const alerts = await notificationsAbout('att8');
    expect(alerts).toHaveLength(activeSuperAdmins);
    expect(alerts[0]).toMatchObject({ type: 'security', payload: { event: 'idle_logout', idleMinutes: 30 } });
  });

  it('does nothing the second time, and leaves active people alone', async () => {
    await checkIn('att9');
    await ageSession('att9', 5);
    const before = (await records('att9'))[0];
    const result = await sweep.sweepOnce();
    expect(result.idleEnded).toBe(0);
    expect((await records('att9'))[0].check_out_at).toBe(before.check_out_at);
  });

  it('does not alert anyone about a Super Admin who went quiet', async () => {
    await api.signIn('idle');
    await ageSession('idle', 45);
    await sweep.sweepOnce();
    const session = (await owner.query(`SELECT ended_reason FROM user_sessions WHERE user_id = $1`, [fx.user('idle').id])).rows[0];
    expect(session.ended_reason).toBe('inactivity');
    expect(await notificationsAbout('idle')).toHaveLength(0);
  });

  it('uses the idle limit the company has set', async () => {
    await useSettings({ idle: 60 });
    await api.signIn('expired');
    await ageSession('expired', 45);
    await sweep.sweepOnce();
    let ended = (await owner.query(`SELECT ended_at FROM user_sessions WHERE user_id = $1`, [fx.user('expired').id])).rows[0].ended_at;
    expect(ended).toBeNull();

    await ageSession('expired', 61);
    await sweep.sweepOnce();
    ended = (await owner.query(`SELECT ended_at FROM user_sessions WHERE user_id = $1`, [fx.user('expired').id])).rows[0].ended_at;
    expect(ended).not.toBeNull();
  });

  it('ends sessions that reached their maximum age and checks the person out as forced', async () => {
    await checkIn('att10');
    await owner.query(`UPDATE user_sessions SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [fx.user('att10').id]);
    const result = await sweep.sweepOnce();
    expect(result.expiredEnded).toBeGreaterThanOrEqual(1);
    expect((await records('att10'))[0].check_out_reason).toBe('forced');
  });
});

// ----------------------------------------------------------------- breaks

describe('breaks', () => {
  beforeEach(() => useSettings());
  const start = (token: string, breakTypeId: string) => api.call('POST', '/attendance/breaks/start', token, { breakTypeId }, OFFICE_IP);
  const end = (token: string) => api.call('POST', '/attendance/breaks/end', token, undefined, OFFICE_IP);
  const typeId = async (name: string) =>
    (await owner.query(`SELECT id FROM break_types WHERE tenant_id = $1 AND name = $2`, [fx.tenantId, name])).rows[0].id as string;

  it('shows the kinds of break and today\'s state', async () => {
    const token = await checkIn('mobile');
    const types = await api.call('GET', '/attendance/break-types', token, undefined, OFFICE_IP);
    expect(types.json().map((t: { name: string }) => t.name)).toEqual(['Lunch', 'Tea']);

    const today = await api.call('GET', '/attendance/me/today', token, undefined, OFFICE_IP);
    expect(today.json()).toMatchObject({
      tracked: true, checkedIn: true, onBreak: null, breakMinutesToday: 0,
      shift: { start: '10:00', end: '19:00', graceMinutes: 10, idleTimeoutMin: 30 },
      record: { method: 'office_check' },
    });
  });

  it('lists a person own attendance without letting them see anyone else', async () => {
    const token = await checkIn('mobile');
    const mine = await api.call('GET', '/attendance/me', token, undefined, OFFICE_IP);
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.json().items.length).toBeGreaterThanOrEqual(1);
    expect(mine.json().items.every((r: { user: { name: string } }) => r.user.name === 'mobile')).toBe(true);
    expect((await api.call('GET', '/attendance', token, undefined, OFFICE_IP)).statusCode).toBe(403); // the team list stays closed
  });

  it('starts and ends a break, and reports minutes over the allowance', async () => {
    const token = await checkIn('victim');
    const lunch = await typeId('Lunch');

    const started = await start(token, lunch);
    expect(started.statusCode).toBe(200);
    expect(started.json().type).toMatchObject({ name: 'Lunch', allowedMinutes: 45 });
    expect(errorCode(await start(token, lunch))).toBe('BREAK_ALREADY_OPEN');
    expect((await api.call('GET', '/attendance/me/today', token, undefined, OFFICE_IP)).json().onBreak).toMatchObject({ type: { name: 'Lunch' } });

    await owner.query(`UPDATE break_logs SET started_at = now() - interval '50 minutes' WHERE id = $1`, [started.json().id]);
    const ended = await end(token);
    expect(ended.statusCode).toBe(200);
    expect(ended.json().usedTodayMinutes).toBeGreaterThanOrEqual(50);
    expect(ended.json().overByMinutes).toBeGreaterThanOrEqual(5);

    expect(errorCode(await end(token))).toBe('NO_OPEN_BREAK');
  });

  it('refuses unknown or switched-off kinds of break', async () => {
    const token = await checkIn('resetme');
    expect((await start(token, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);

    const tea = await typeId('Tea');
    await api.call('PATCH', `/attendance/break-types/${tea}`, sa, { isActive: false });
    expect(errorCode(await start(token, tea))).toBe('BREAK_TYPE_INACTIVE');
    const listed = await api.call('GET', '/attendance/break-types', token, undefined, OFFICE_IP);
    expect(listed.json().map((t: { name: string }) => t.name)).toEqual(['Lunch']);
    await api.call('PATCH', `/attendance/break-types/${tea}`, sa, { isActive: true });
  });

  it('closes a break that is still running when the person is checked out', async () => {
    const token = await checkIn('perms');
    const started = await start(token, await typeId('Tea'));
    await api.call('POST', '/auth/logout', token, undefined, OFFICE_IP);

    const [r] = await records('perms');
    const brk = (await owner.query(`SELECT ended_at FROM break_logs WHERE id = $1`, [started.json().id])).rows[0];
    expect(brk.ended_at).not.toBeNull();
    expect(brk.ended_at).toEqual(r.check_out_at);
  });

  it('is not available to someone whose attendance is not recorded', async () => {
    const res = await api.call('POST', '/attendance/breaks/start', sa, { breakTypeId: await typeId('Lunch') });
    expect(errorCode(res)).toBe('NOT_TRACKED');
  });
});

// ---------------------------------------------------------------- reading

describe('reading attendance', () => {
  beforeAll(async () => {
    await useSettings();
    await checkIn('counsellor');
    await checkIn('counsellor2');
  });

  it('shows an Admin their own team only', async () => {
    const res = await api.call('GET', '/attendance?limit=100', admin, undefined, OFFICE_IP);
    expect(res.statusCode).toBe(200);
    const names = res.json().items.map((i: { user: { name: string } }) => i.user.name);
    expect(names).toContain('counsellor');
    expect(names).not.toContain('counsellor2');
    expect(res.json().items[0]).toEqual(expect.objectContaining({
      workDate: await localDate(), method: 'office_check', lateMinutes: expect.any(Number),
      presentMinutes: expect.any(Number), breakMinutes: 0, workedMinutes: expect.any(Number),
    }));
  });

  it('shows a Super Admin everyone, and a counsellor nothing', async () => {
    const all = await api.call('GET', '/attendance?limit=100', sa);
    const names = all.json().items.map((i: { user: { name: string } }) => i.user.name);
    expect(names).toEqual(expect.arrayContaining(['counsellor', 'counsellor2']));

    const token = await checkIn('att1');
    expect((await api.call('GET', '/attendance', token, undefined, OFFICE_IP)).statusCode).toBe(403);
  });

  it('filters by person, day and lateness', async () => {
    const one = await api.call('GET', `/attendance?userId=${fx.user('counsellor2').id}`, sa);
    expect(one.json().items.map((i: { user: { name: string } }) => i.user.name)).toEqual(['counsellor2']);

    const future = await api.call('GET', `/attendance?from=${await localDate(2)}`, sa);
    expect(future.json().items).toHaveLength(0);
    const upToday = await api.call('GET', `/attendance?to=${await localDate()}&from=${await localDate()}`, sa);
    expect(upToday.json().items.length).toBeGreaterThan(0);

    const late = await api.call('GET', '/attendance?lateOnly=true&limit=100', sa);
    expect(late.json().items.every((i: { lateMinutes: number }) => i.lateMinutes > 0)).toBe(true);
    expect(errorCode(await api.call('GET', '/attendance?from=2026-13-45', sa))).toBe('VALIDATION_FAILED');
  });

  it('pages through the records exactly once', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await api.call('GET', `/attendance?limit=3${cursor ? `&cursor=${cursor}` : ''}`, sa);
      seen.push(...res.json().items.map((i: { id: string }) => i.id));
      cursor = res.json().nextCursor;
      pages++;
    } while (cursor && pages < 30);
    expect(new Set(seen).size).toBe(seen.length);
    const total = Number((await owner.query(`SELECT count(*) FROM attendance_records WHERE tenant_id = $1`, [fx.tenantId])).rows[0].count);
    expect(seen.length).toBe(total);
  });
});

// -------------------------------------------------------------- exceptions

describe('attendance exceptions', () => {
  beforeEach(() => useSettings());
  const raise = (token: string, body: Record<string, unknown>, ip = OFFICE_IP) =>
    api.call('POST', '/attendance/exceptions', token, body, ip);
  const reason = 'The office network was down in the morning';

  it('marks a missed day present, with the shift times and a reason on record', async () => {
    const date = await localDate(-2);
    const res = await raise(admin, { userId: fx.user('att1').id, date, reason });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ workDate: date, method: 'exception', lateMinutes: 0, user: { name: 'att1' }, checkOutReason: 'shift_end' });
    expect(res.json().presentMinutes).toBe(9 * 60);

    const logged = (await owner.query(
      `SELECT reason, approved_by FROM attendance_exceptions WHERE attendance_id = $1`, [res.json().id],
    )).rows[0];
    expect(logged).toMatchObject({ reason, approved_by: fx.user('admin').id });
    expect((await owner.query(`SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND action = 'attendance.exception'`, [fx.tenantId])).rows[0].n).toBeGreaterThanOrEqual(1);
    const alert = (await owner.query(`SELECT payload FROM notifications WHERE tenant_id = $1 AND payload->>'event' = 'attendance_exception' AND payload->>'userName' = 'att1' LIMIT 1`, [fx.tenantId])).rows[0];
    expect(alert.payload).toMatchObject({ event: 'attendance_exception', reason, date });
  });

  it('accepts explicit times', async () => {
    const res = await raise(admin, { userId: fx.user('att2').id, date: await localDate(-3), reason, checkInTime: '09:30', checkOutTime: '18:15' });
    expect(res.statusCode).toBe(201);
    expect(res.json().presentMinutes).toBe(8 * 60 + 45);
  });

  it('leaves today open, and a later sign-in the same day reopens it without changing its kind', async () => {
    const res = await raise(admin, { userId: fx.user('att11').id, date: await localDate(), reason });
    expect(res.statusCode).toBe(201);
    expect(res.json().checkOutAt).toBeNull();

    await checkIn('att11');
    const rows = await records('att11');
    const todays = rows.filter((r) => r.work_date === res.json().workDate);
    expect(todays).toHaveLength(1);
    expect(todays[0].method).toBe('exception');
  });

  it('does not overwrite a day that already has attendance', async () => {
    const date = await localDate(-2);
    expect(errorCode(await raise(admin, { userId: fx.user('att1').id, date, reason }))).toBe('ATTENDANCE_EXISTS');
  });

  it.each([
    ['for yourself', () => ({ userId: fx.user('admin').id, date: 'D' }), 403, 'SELF_EXCEPTION'],
    ['for someone outside your team', () => ({ userId: fx.user('counsellor2').id, date: 'D' }), 404, 'NOT_FOUND'],
    ['for a future day', () => ({ userId: fx.user('att4').id, date: 'FUTURE' }), 400, 'DATE_IN_FUTURE'],
    ['for a day too long ago', () => ({ userId: fx.user('att4').id, date: 'OLD' }), 400, 'DATE_TOO_OLD'],
    ['without a real reason', () => ({ userId: fx.user('att4').id, date: 'D', reason: 'no' }), 400, 'VALIDATION_FAILED'],
    ['with check-out before check-in', () => ({ userId: fx.user('att4').id, date: 'D', checkInTime: '12:00', checkOutTime: '09:00' }), 400, 'VALIDATION_FAILED'],
  ])('refuses an exception %s', async (_name, build, status, code) => {
    const dates = { D: await localDate(-5), FUTURE: await localDate(3), OLD: await localDate(-45) };
    const body = { reason, ...build() } as Record<string, unknown>;
    body.date = dates[body.date as keyof typeof dates] ?? body.date;
    const res = await raise(admin, body);
    expect(res.statusCode).toBe(status);
    expect(errorCode(res)).toBe(code);
  });

  it('is for people whose attendance is recorded, and for those allowed to raise one', async () => {
    const notTracked = await raise(sa, { userId: fx.user('lockme').id, date: await localDate(-1), reason });
    expect(errorCode(notTracked)).toBe('NOT_TRACKED');

    const token = await checkIn('att5');
    expect((await raise(token, { userId: fx.user('att4').id, date: await localDate(-1), reason })).statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------- settings

describe('attendance settings', () => {
  beforeEach(() => useSettings());
  const next = {
    shiftStart: '09:30', shiftEnd: '18:30', graceMinutes: 15, halfDayBelowHours: 5, idleTimeoutMin: 45, weeklyOffDays: [0, 6, 0],
  };

  it('are for those who may change them', async () => {
    expect((await api.call('GET', '/attendance/settings', admin, undefined, OFFICE_IP)).statusCode).toBe(403);
    expect((await api.call('PUT', '/attendance/settings', admin, next, OFFICE_IP)).statusCode).toBe(403);
    const view = await api.call('GET', '/attendance/settings', sa);
    expect(view.json().current).toMatchObject({ shiftStart: '10:00', shiftEnd: '19:00', graceMinutes: 10, idleTimeoutMin: 30, weeklyOffDays: [0] });
    expect(view.json().breakTypes.map((b: { name: string }) => b.name)).toEqual(['Lunch', 'Tea']);
  });

  it('keep the old rules as history when new ones start, so a past month can be explained', async () => {
    const saved = await api.call('PUT', '/attendance/settings', sa, next);
    expect(saved.statusCode).toBe(200);
    expect(saved.json().current).toMatchObject({ effectiveFrom: await localDate(), shiftStart: '09:30', graceMinutes: 15, weeklyOffDays: [0, 6] });
    expect(saved.json().history).toHaveLength(1);
    expect(saved.json().history[0]).toMatchObject({ shiftStart: '10:00' });

    const again = await api.call('PUT', '/attendance/settings', sa, { ...next, graceMinutes: 20 });
    expect(again.json().current.graceMinutes).toBe(20);
    expect(again.json().history).toHaveLength(1); // same start day: replaced, not duplicated

    const today = await checkIn('att6').then((t) => api.call('GET', '/attendance/me/today', t, undefined, OFFICE_IP));
    expect(today.json().shift).toMatchObject({ start: '09:30', end: '18:30', graceMinutes: 20, idleTimeoutMin: 45 });
  });

  it('can start on a later day without changing today', async () => {
    const later = await localDate(7);
    const saved = await api.call('PUT', '/attendance/settings', sa, { ...next, effectiveFrom: later });
    expect(saved.json().current).toMatchObject({ shiftStart: '10:00' });
    expect(saved.json().upcoming).toHaveLength(1);
    expect(saved.json().upcoming[0]).toMatchObject({ effectiveFrom: later, shiftStart: '09:30' });
  });

  it('refuses a start in the past or a shift that ends before it starts', async () => {
    expect(errorCode(await api.call('PUT', '/attendance/settings', sa, { ...next, effectiveFrom: await localDate(-1) }))).toBe('DATE_IN_PAST');
    const backwards = await api.call('PUT', '/attendance/settings', sa, { ...next, shiftEnd: '08:00' });
    expect(errorCode(backwards)).toBe('VALIDATION_FAILED');
    expect(backwards.json().error.fieldErrors[0].field).toBe('shiftEnd');
    expect(errorCode(await api.call('PUT', '/attendance/settings', sa, { ...next, idleTimeoutMin: 1 }))).toBe('VALIDATION_FAILED');
  });

  it('manages break types', async () => {
    const created = await api.call('POST', '/attendance/break-types', sa, { name: 'Prayer', allowedMinutes: 10 });
    expect(created.statusCode).toBe(201);
    expect(errorCode(await api.call('POST', '/attendance/break-types', sa, { name: 'prayer', allowedMinutes: 5 }))).toBe('BREAK_TYPE_EXISTS');

    const edited = await api.call('PATCH', `/attendance/break-types/${created.json().id}`, sa, { allowedMinutes: 20 });
    expect(edited.json()).toMatchObject({ name: 'Prayer', allowedMinutes: 20, isActive: true });

    const counsellor = await checkIn('att12');
    const seen = await api.call('GET', '/attendance/break-types', counsellor, undefined, OFFICE_IP);
    expect(seen.json().map((t: { name: string }) => t.name)).toContain('Prayer');
    expect((await api.call('POST', '/attendance/break-types', counsellor, { name: 'Nap', allowedMinutes: 5 }, OFFICE_IP)).statusCode).toBe(403);
    expect((await api.call('POST', '/attendance/break-types', admin, { name: 'Nap', allowedMinutes: 5 }, OFFICE_IP)).statusCode).toBe(403);
  });
});

// ------------------------------------------------------------ location log

describe('location log', () => {
  it('lists where people signed in from, with the distance from the office, and who was refused', async () => {
    await checkIn('att10');
    expect(errorCode(await api.login({ ...api.credentials('att11'), location: { ...inOffice, lat: inOffice.lat + 0.05 } }, OFFICE_IP))).toBe('OUTSIDE_OFFICE');

    const res = await api.call('GET', '/attendance/location-log', admin);
    expect(res.statusCode, res.body).toBe(200);
    const items = res.json() as { kind: string; user: { name: string }; ip: string | null; position: { lat: number } | null; distanceM: number | null; result: string | null }[];

    const signedIn = items.find((i) => i.kind === 'signed_in' && i.user.name === 'att10')!;
    expect(signedIn.position).not.toBeNull();
    expect(signedIn.distanceM).toBeLessThan(200);
    expect(signedIn.ip).toBe(OFFICE_IP);

    const refused = items.find((i) => i.kind === 'refused' && i.user.name === 'att11')!;
    expect(refused.result).toBe('outside_office');
    expect(refused.distanceM).toBeGreaterThan(1000);

    const onlyRefused = (await api.call('GET', '/attendance/location-log?kind=refused', admin)).json() as { kind: string }[];
    expect(onlyRefused.length).toBeGreaterThanOrEqual(1);
    expect(onlyRefused.every((i) => i.kind === 'refused')).toBe(true);
  });

  it('keeps to a team and a sensible range, and is closed to counsellors', async () => {
    expect((await api.call('GET', '/attendance/location-log?from=2026-02-02&to=2026-02-01', admin)).json().error.code).toBe('RANGE_INVALID');
    expect((await api.call('GET', '/attendance/location-log?from=2026-01-01&to=2026-12-31', admin)).json().error.code).toBe('RANGE_TOO_LONG');
    const lc = await checkIn('att12');
    expect((await api.call('GET', '/attendance/location-log', lc, undefined, OFFICE_IP)).statusCode).toBe(403);
  });
});
