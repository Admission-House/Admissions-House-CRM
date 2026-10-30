import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { startApp } from './helpers/app.js';
import { Client, makeClient } from './helpers/client.js';
import { createFixture, Fixture, OFFICE_IP } from './helpers/fixtures.js';

let app: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;
let api: Client;
let sa: string;
let admin: string;
let admin2: string;

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  app = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500' });
  api = makeClient(app, fx);
  sa = await api.signIn('super');
  admin = await api.signIn('admin', { office: true });
  admin2 = await api.signIn('admin2', { office: true });
  // Sunday is the weekly off.
  await owner.query(`UPDATE attendance_settings SET weekly_off_days = '{0}' WHERE tenant_id = $1`, [fx.tenantId]);
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.end();
});

// ------------------------------------------------------------------ helpers

const errorCode = (res: { json: () => { error?: { code?: string } } }) => res.json().error?.code;
const asOffice = (name: string) => api.signIn(name, { office: true });

/** The company's date `offset` days from today, as YYYY-MM-DD. */
const day = async (offset: number) =>
  (await owner.query(`SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date + $1::int)::text AS d`, [offset])).rows[0].d as string;

/** The next Sunday at least `minAhead` days from today. */
async function nextSunday(minAhead = 3): Promise<string> {
  return (
    await owner.query(
      `SELECT d::date::text AS d FROM generate_series((now() AT TIME ZONE 'Asia/Kolkata')::date + $1::int,
                                                 (now() AT TIME ZONE 'Asia/Kolkata')::date + $1::int + 6, '1 day') d
       WHERE EXTRACT(DOW FROM d) = 0`,
      [minAhead],
    )
  ).rows[0].d;
}
const plusDays = async (date: string, n: number) =>
  (await owner.query(`SELECT ($1::date + $2::int)::text AS d`, [date, n])).rows[0].d as string;

const typeId = async (name: string) =>
  (await owner.query(`SELECT id FROM leave_types WHERE tenant_id = $1 AND name = $2`, [fx.tenantId, name])).rows[0].id as string;

const request = (token: string, body: Record<string, unknown>, ip?: string) =>
  api.call('POST', '/leave/requests', token, body, ip);

const balanceOf = async (token: string, typeName: string, query = '') => {
  const res = await api.call('GET', `/leave/balances${query}`, token);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().balances.find((b: { leaveType: { name: string } }) => b.leaveType.name === typeName);
};

const notificationsFor = async (name: string, event: string) =>
  (
    await owner.query(
      `SELECT payload FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND payload->>'event' = $3`,
      [fx.tenantId, fx.user(name).id, event],
    )
  ).rows;

// ===================================================================== types

describe('kinds of leave', () => {
  it('are visible to those who take part in leave, and managed by those who set the rules', async () => {
    const token = await asOffice('lv1');
    const list = await api.call('GET', '/leave/types', token, undefined, OFFICE_IP);
    expect(list.json().map((t: { name: string }) => t.name)).toEqual(['Casual Leave', 'Sick Leave', 'Unpaid Leave']);
    expect((await api.call('POST', '/leave/types', token, { name: 'Study', isPaid: true, yearlyQuota: 3 }, OFFICE_IP)).statusCode).toBe(403);
    expect((await api.call('POST', '/leave/types', admin, { name: 'Study', isPaid: true, yearlyQuota: 3 }, OFFICE_IP)).statusCode).toBe(403);

    const created = await api.call('POST', '/leave/types', sa, { name: 'Comp Off', isPaid: true, yearlyQuota: 2.5 });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: 'Comp Off', isPaid: true, yearlyQuota: 2.5, isActive: true });
    expect(errorCode(await api.call('POST', '/leave/types', sa, { name: 'comp off', isPaid: true, yearlyQuota: 1 }))).toBe('LEAVE_TYPE_EXISTS');
    expect(errorCode(await api.call('POST', '/leave/types', sa, { name: 'Odd', isPaid: true, yearlyQuota: 1.3 }))).toBe('VALIDATION_FAILED');

    const off = await api.call('PATCH', `/leave/types/${created.json().id}`, sa, { isActive: false });
    expect(off.json().isActive).toBe(false);
    const hidden = await api.call('GET', '/leave/types', token, undefined, OFFICE_IP);
    expect(hidden.json().map((t: { name: string }) => t.name)).not.toContain('Comp Off');
    const managerView = await api.call('GET', '/leave/types', sa);
    expect(managerView.json().map((t: { name: string }) => t.name)).toContain('Comp Off');
  });
});

// ================================================================== holidays

describe('holidays', () => {
  it('are listed for everyone in leave and managed by those who set the rules', async () => {
    const date = await plusDays(await nextSunday(40), 1);
    const year = Number(date.slice(0, 4));
    const created = await api.call('POST', '/holidays', sa, { date, name: 'Founders Day' });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ date, name: 'Founders Day' });
    expect(errorCode(await api.call('POST', '/holidays', sa, { date, name: 'Again' }))).toBe('HOLIDAY_EXISTS');
    expect(errorCode(await api.call('POST', '/holidays', sa, { date: '2026-02-31', name: 'Fake' }))).toBe('VALIDATION_FAILED');

    const token = await asOffice('lv2');
    const list = await api.call('GET', `/holidays?year=${year}`, token, undefined, OFFICE_IP);
    expect(list.json().map((h: { date: string }) => h.date)).toContain(date);
    expect((await api.call('POST', '/holidays', token, { date: await plusDays(date, 1), name: 'Mine' }, OFFICE_IP)).statusCode).toBe(403);

    const renamed = await api.call('PATCH', `/holidays/${created.json().id}`, sa, { name: 'Foundation Day' });
    expect(renamed.json().name).toBe('Foundation Day');
    expect((await api.call('DELETE', `/holidays/${created.json().id}`, sa)).statusCode).toBe(204);
    expect((await api.call('DELETE', `/holidays/${created.json().id}`, sa)).statusCode).toBe(404);
  });
});

// ================================================================== balances

describe('balances', () => {
  it('start at the yearly quota', async () => {
    const token = await asOffice('lv3');
    expect(await balanceOf(token, 'Casual Leave')).toMatchObject({ yearlyQuota: 12, remaining: 12, pending: 0, available: 12 });
    expect(await balanceOf(token, 'Sick Leave')).toMatchObject({ yearlyQuota: 6, remaining: 6 });
    expect(await balanceOf(token, 'Unpaid Leave')).toMatchObject({ yearlyQuota: 0, available: null });
  });

  it('can be read for others only inside your own scope', async () => {
    const counsellor = await asOffice('lv3');
    expect((await api.call('GET', `/leave/balances?userId=${fx.user('lv4').id}`, counsellor, undefined, OFFICE_IP)).statusCode).toBe(403);

    expect(await balanceOf(admin, 'Casual Leave', `&userId=${fx.user('lv3').id}`.replace('&', '?'))).toMatchObject({ remaining: 12 });
    const outside = await api.call('GET', `/leave/balances?userId=${fx.user('counsellor2').id}`, admin, undefined, OFFICE_IP);
    expect(outside.statusCode).toBe(404);
    expect((await api.call('GET', `/leave/balances?userId=${fx.user('counsellor2').id}`, sa)).statusCode).toBe(200);
  });
});

// ================================================================== requests

describe('asking for leave', () => {
  it('counts only working days, sets the days aside and tells the approvers', async () => {
    const token = await asOffice('lv1');
    const sunday = await nextSunday();
    const saturday = await plusDays(sunday, -1);
    const monday = await plusDays(sunday, 1);

    const res = await request(token, { leaveTypeId: await typeId('Casual Leave'), fromDate: saturday, toDate: monday, reason: 'Family function' }, OFFICE_IP);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({
      status: 'pending', days: 2, reason: 'Family function', fromDate: saturday, toDate: monday,
      user: { name: 'lv1' }, leaveType: { name: 'Casual Leave', isPaid: true }, decidedBy: null,
    });

    expect(await balanceOf(token, 'Casual Leave')).toMatchObject({ remaining: 12, pending: 2, available: 10 });

    const activeSuperAdmins = Number((await owner.query(
      `SELECT count(*) FROM users u JOIN roles r ON r.id = u.role_id WHERE u.tenant_id = $1 AND r.system_key = 'super_admin' AND u.status = 'active'`,
      [fx.tenantId],
    )).rows[0].count);
    const toManager = await notificationsFor('admin', 'leave_requested');
    expect(toManager.some((n) => n.payload.userName === 'lv1' && n.payload.days === 2)).toBe(true);
    const toSuper = await notificationsFor('super', 'leave_requested');
    expect(toSuper.length).toBeGreaterThanOrEqual(1);
    const total = Number((await owner.query(`SELECT count(*) FROM notifications WHERE tenant_id = $1 AND payload->>'event' = 'leave_requested' AND payload->>'userName' = 'lv1'`, [fx.tenantId])).rows[0].count);
    expect(total).toBe(activeSuperAdmins + 1);
  });

  it('does not spend leave on a company holiday', async () => {
    const token = await asOffice('lv2');
    const sunday = await nextSunday(10);
    const monday = await plusDays(sunday, 1);
    await api.call('POST', '/holidays', sa, { date: monday, name: 'Test Holiday' });
    const res = await request(token, { leaveTypeId: await typeId('Casual Leave'), fromDate: monday, toDate: await plusDays(monday, 1) }, OFFICE_IP);
    expect(res.json().days).toBe(1); // Tuesday only
    expect(errorCode(await request(token, { leaveTypeId: await typeId('Sick Leave'), fromDate: monday }, OFFICE_IP))).toBe('NO_WORKING_DAYS');
  });

  it('allows a half day', async () => {
    const token = await asOffice('lv3');
    const monday = await plusDays(await nextSunday(20), 1);
    const res = await request(token, { leaveTypeId: await typeId('Casual Leave'), fromDate: monday, halfDay: true }, OFFICE_IP);
    expect(res.json()).toMatchObject({ days: 0.5, fromDate: monday, toDate: monday });
  });

  it('refuses leave that overlaps leave already asked for', async () => {
    const token = await asOffice('lv1');
    const sunday = await nextSunday();
    const monday = await plusDays(sunday, 1);
    const clash = await request(token, { leaveTypeId: await typeId('Sick Leave'), fromDate: monday, toDate: await plusDays(monday, 2) }, OFFICE_IP);
    expect(clash.statusCode).toBe(409);
    expect(errorCode(clash)).toBe('LEAVE_OVERLAP');
  });

  it('refuses more days than are available', async () => {
    const token = await asOffice('lv4');
    const start = await plusDays(await nextSunday(2), 1);
    const res = await request(token, { leaveTypeId: await typeId('Casual Leave'), fromDate: start, toDate: await plusDays(start, 20) }, OFFICE_IP);
    // Only possible if the range stays inside the year; otherwise the year rule answers first.
    expect([422, 400]).toContain(res.statusCode);
    if (res.statusCode === 422) {
      expect(errorCode(res)).toBe('INSUFFICIENT_BALANCE');
      expect(res.json().error.message).toContain('Casual Leave');
    }
  });

  it('does not limit unpaid leave by a balance', async () => {
    const token = await asOffice('lv5');
    const start = await plusDays(await nextSunday(2), 1);
    const res = await request(token, { leaveTypeId: await typeId('Unpaid Leave'), fromDate: start, toDate: await plusDays(start, 4) }, OFFICE_IP);
    expect(res.statusCode).toBe(201);
    expect(res.json().days).toBe(5);
  });

  it.each([
    ['dates the wrong way round', async () => ({ fromDate: await day(8), toDate: await day(5) }), 'DATES_REVERSED'],
    ['a half day over several days', async () => ({ fromDate: await day(8), toDate: await day(9), halfDay: true }), 'HALF_DAY_SINGLE'],
    ['leave across New Year', async () => ({ fromDate: '2030-12-30', toDate: '2031-01-02' }), 'SPANS_YEARS'],
    ['leave starting too long ago', async () => ({ fromDate: await day(-60), toDate: await day(-59) }), 'DATE_TOO_OLD'],
    ['a day that is only a weekly off', async () => ({ fromDate: await nextSunday(5) }), 'NO_WORKING_DAYS'],
  ])('refuses %s', async (_name, build, code) => {
    const token = await asOffice('lv6');
    const res = await request(token, { leaveTypeId: await typeId('Casual Leave'), ...(await build()) }, OFFICE_IP);
    expect(res.statusCode, res.body).toBe(400);
    expect(errorCode(res), res.body).toBe(code);
  });

  it('refuses a kind of leave that does not exist or is switched off', async () => {
    const token = await asOffice('lv6');
    const body = { fromDate: await day(8) };
    expect(errorCode(await request(token, { ...body, leaveTypeId: '00000000-0000-4000-8000-000000000000' }, OFFICE_IP))).toBe('LEAVE_TYPE_INVALID');
    const comp = (await owner.query(`SELECT id FROM leave_types WHERE tenant_id = $1 AND name = 'Comp Off'`, [fx.tenantId])).rows[0].id;
    expect(errorCode(await request(token, { ...body, leaveTypeId: comp }, OFFICE_IP))).toBe('LEAVE_TYPE_INVALID');
  });
});

// ================================================================== decisions

describe('deciding on leave', () => {
  let sunday = '';
  beforeAll(async () => {
    sunday = await nextSunday(30);
  });
  const makeRequest = async (name: string, offsetFromSunday = 1, type = 'Casual Leave') => {
    const token = await asOffice(name);
    const date = await plusDays(sunday, offsetFromSunday);
    const res = await request(token, { leaveTypeId: await typeId(type), fromDate: date }, OFFICE_IP);
    expect(res.statusCode, res.body).toBe(201);
    return { token, id: res.json().id as string, date };
  };
  const decide = (token: string, id: string, body: Record<string, unknown>, ip = OFFICE_IP) =>
    api.call('POST', `/leave/requests/${id}/decision`, token, body, ip);

  it('lets the Admin of the team approve: the days are taken from the balance and the person is told', async () => {
    const { token, id } = await makeRequest('lv7');
    const res = await decide(admin, id, { decision: 'approved' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: 'approved', decidedBy: 'admin' });
    expect(await balanceOf(token, 'Casual Leave')).toMatchObject({ remaining: 11, pending: 0, available: 11 });

    const told = await notificationsFor('lv7', 'leave_decided');
    expect(told[0].payload).toMatchObject({ decision: 'approved', decidedBy: 'admin' });
    expect(errorCode(await decide(admin, id, { decision: 'approved' }))).toBe('ALREADY_DECIDED');
    expect(await balanceOf(token, 'Casual Leave')).toMatchObject({ remaining: 11 });
  });

  it('needs a reason to turn a request down, and leaves the balance alone', async () => {
    const { token, id, date } = await makeRequest('lv8', 2);
    expect(errorCode(await decide(admin, id, { decision: 'rejected' }))).toBe('VALIDATION_FAILED');
    const res = await decide(admin, id, { decision: 'rejected', note: 'Busy admission week' });
    expect(res.json()).toMatchObject({ status: 'rejected', decisionNote: 'Busy admission week' });
    expect(await balanceOf(token, 'Casual Leave')).toMatchObject({ remaining: 12, pending: 0 });

    // A refused request no longer blocks the same days.
    const again = await request(token, { leaveTypeId: await typeId('Casual Leave'), fromDate: date }, OFFICE_IP);
    expect(again.statusCode).toBe(201);
  });

  it('keeps decisions to the right people', async () => {
    const { token, id } = await makeRequest('lv9', 3);
    expect(errorCode(await decide(token, id, { decision: 'approved' }))).toBe('FORBIDDEN');
    expect((await decide(admin2, id, { decision: 'approved' })).statusCode).toBe(404); // not their team
    expect((await decide(sa, id, { decision: 'approved' }, '203.0.113.50')).statusCode).toBe(200); // a Super Admin may
  });

  it('does not let anyone decide on their own leave', async () => {
    const date = await plusDays(sunday, 4);
    const own = await request(admin, { leaveTypeId: await typeId('Casual Leave'), fromDate: date }, OFFICE_IP);
    expect(own.statusCode).toBe(201);
    const res = await decide(admin, own.json().id, { decision: 'approved' });
    expect(res.statusCode).toBe(403);
    expect(errorCode(res)).toBe('SELF_APPROVAL');
    // The Super Admins are the ones told about an Admin's leave.
    expect((await decide(sa, own.json().id, { decision: 'approved' }, '203.0.113.50')).statusCode).toBe(200);
  });

  it('checks the balance again when approving, so two requests cannot overspend', async () => {
    const date = await plusDays(sunday, 5);
    const inserted = await owner.query(
      `INSERT INTO leave_requests (tenant_id, user_id, leave_type_id, from_date, to_date, days)
       VALUES ($1, $2, $3, $4::date, $4::date, 20) RETURNING id`,
      [fx.tenantId, fx.user('lv10').id, await typeId('Casual Leave'), date],
    );
    const res = await decide(admin, inserted.rows[0].id, { decision: 'approved' });
    expect(res.statusCode).toBe(422);
    expect(errorCode(res)).toBe('INSUFFICIENT_BALANCE');
    const stillPending = (await owner.query(`SELECT status FROM leave_requests WHERE id = $1`, [inserted.rows[0].id])).rows[0].status;
    expect(stillPending).toBe('pending');
  });
});

// ==================================================================== cancel

describe('withdrawing a request', () => {
  const futureRequest = async (name: string, offset: number) => {
    const token = await asOffice(name);
    const date = await plusDays(await nextSunday(50), offset);
    const res = await request(token, { leaveTypeId: await typeId('Sick Leave'), fromDate: date }, OFFICE_IP);
    expect(res.statusCode, res.body).toBe(201);
    return { token, id: res.json().id as string };
  };
  const cancel = (token: string, id: string) => api.call('POST', `/leave/requests/${id}/cancel`, token, undefined, OFFICE_IP);

  it('cancels a waiting request', async () => {
    const { token, id } = await futureRequest('att1', 1);
    expect((await cancel(token, id)).json().status).toBe('cancelled');
    expect(await balanceOf(token, 'Sick Leave')).toMatchObject({ pending: 0 });
    expect(errorCode(await cancel(token, id))).toBe('NOT_CANCELLABLE');
  });

  it('gives the days back when approved leave that has not started is cancelled', async () => {
    const { token, id } = await futureRequest('att2', 2);
    await api.call('POST', `/leave/requests/${id}/decision`, admin, { decision: 'approved' }, OFFICE_IP);
    expect(await balanceOf(token, 'Sick Leave')).toMatchObject({ remaining: 5 });
    expect((await cancel(token, id)).json().status).toBe('cancelled');
    expect(await balanceOf(token, 'Sick Leave')).toMatchObject({ remaining: 6 });
  });

  it('will not cancel leave that has already started', async () => {
    const token = await asOffice('att3');
    const today = await day(0);
    const row = await owner.query(
      `INSERT INTO leave_requests (tenant_id, user_id, leave_type_id, from_date, to_date, days, status, decided_by, decided_at)
       VALUES ($1, $2, $3, $4::date, $4::date, 1, 'approved', $5, now()) RETURNING id`,
      [fx.tenantId, fx.user('att3').id, await typeId('Unpaid Leave'), today, fx.user('admin').id],
    );
    expect(errorCode(await cancel(token, row.rows[0].id))).toBe('LEAVE_STARTED');
  });

  it('is only for the person who asked', async () => {
    const { id } = await futureRequest('att4', 3);
    const other = await asOffice('att5');
    expect((await cancel(other, id)).statusCode).toBe(404);
    expect((await cancel(admin, id)).statusCode).toBe(404); // even an Admin who may approve it
  });
});

// ===================================================================== lists

describe('lists of requests', () => {
  it('show a person their own, and an Admin their team\'s', async () => {
    const mine = await api.call('GET', '/leave/requests/mine?limit=100', await asOffice('lv1'), undefined, OFFICE_IP);
    expect(mine.statusCode).toBe(200);
    expect(mine.json().items.every((r: { user: { name: string } }) => r.user.name === 'lv1')).toBe(true);

    // counsellor2 belongs to the other Admin and asks for leave.
    const other = await asOffice('counsellor2');
    await request(other, { leaveTypeId: await typeId('Unpaid Leave'), fromDate: await plusDays(await nextSunday(60), 1) }, OFFICE_IP);

    const team = await api.call('GET', '/leave/requests?limit=100', admin, undefined, OFFICE_IP);
    const names = team.json().items.map((r: { user: { name: string } }) => r.user.name);
    expect(names).toContain('lv1');
    expect(names).not.toContain('counsellor2');
    const everyone = await api.call('GET', '/leave/requests?limit=100', sa);
    expect(everyone.json().items.map((r: { user: { name: string } }) => r.user.name)).toContain('counsellor2');

    expect((await api.call('GET', '/leave/requests', await asOffice('lv1'), undefined, OFFICE_IP)).statusCode).toBe(403);
  });

  it('filter by status and page through everything once', async () => {
    const approved = await api.call('GET', '/leave/requests?status=approved&limit=100', sa);
    expect(approved.json().items.length).toBeGreaterThan(0);
    expect(approved.json().items.every((r: { status: string }) => r.status === 'approved')).toBe(true);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await api.call('GET', `/leave/requests?limit=3${cursor ? `&cursor=${cursor}` : ''}`, sa);
      seen.push(...res.json().items.map((r: { id: string }) => r.id));
      cursor = res.json().nextCursor;
      pages++;
    } while (cursor && pages < 40);
    expect(new Set(seen).size).toBe(seen.length);
    const total = Number((await owner.query(`SELECT count(*) FROM leave_requests WHERE tenant_id = $1`, [fx.tenantId])).rows[0].count);
    expect(seen.length).toBe(total);
  });
});

// ============================================================== notifications

describe('notifications', () => {
  it('belong to one person: list, count, and mark as read', async () => {
    const token = await asOffice('lv7');
    const list = await api.call('GET', '/notifications', token, undefined, OFFICE_IP);
    expect(list.statusCode).toBe(200);
    const items = list.json().items;
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]).toMatchObject({ type: 'approval', readAt: null, payload: { event: 'leave_decided' } });

    const before = (await api.call('GET', '/notifications/unread-count', token, undefined, OFFICE_IP)).json().unread;
    expect(before).toBeGreaterThan(0);

    const marked = await api.call('POST', '/notifications/read', token, { ids: [items[0].id] }, OFFICE_IP);
    expect(marked.json().marked).toBe(1);
    expect((await api.call('GET', '/notifications/unread-count', token, undefined, OFFICE_IP)).json().unread).toBe(before - 1);
    expect((await api.call('POST', '/notifications/read', token, { ids: [items[0].id] }, OFFICE_IP)).json().marked).toBe(0);

    const unreadOnly = await api.call('GET', '/notifications?unreadOnly=true', token, undefined, OFFICE_IP);
    expect(unreadOnly.json().items.every((n: { readAt: unknown }) => n.readAt === null)).toBe(true);

    await api.call('POST', '/notifications/read', token, { all: true }, OFFICE_IP);
    expect((await api.call('GET', '/notifications/unread-count', token, undefined, OFFICE_IP)).json().unread).toBe(0);
  });

  it('cannot be read or marked by someone else', async () => {
    const other = await asOffice('lv8');
    const theirs = await api.call('GET', '/notifications?limit=100', other, undefined, OFFICE_IP);
    expect(theirs.json().items.every((n: { payload: { userName?: string } }) => n.payload.userName !== 'lv7')).toBe(true);

    const lv7Notification = (await owner.query(
      `SELECT id::text FROM notifications WHERE tenant_id = $1 AND user_id = $2 LIMIT 1`, [fx.tenantId, fx.user('lv7').id],
    )).rows[0].id;
    const attempt = await api.call('POST', '/notifications/read', other, { ids: [lv7Notification] }, OFFICE_IP);
    expect(attempt.json().marked).toBe(0);
  });

  it('pages and refuses a malformed request', async () => {
    const token = await asOffice('att5');
    expect(errorCode(await api.call('POST', '/notifications/read', token, {}, OFFICE_IP))).toBe('VALIDATION_FAILED');
    expect(errorCode(await api.call('POST', '/notifications/read', token, { ids: ['abc'] }, OFFICE_IP))).toBe('VALIDATION_FAILED');

    const first = await api.call('GET', '/notifications?limit=1', sa);
    if (first.json().nextCursor) {
      const second = await api.call('GET', `/notifications?limit=1&cursor=${first.json().nextCursor}`, sa);
      expect(second.json().items[0]?.id).not.toBe(first.json().items[0].id);
    }
  });
});
