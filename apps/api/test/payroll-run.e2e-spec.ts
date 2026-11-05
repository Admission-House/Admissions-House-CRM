import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { startApp } from './helpers/app.js';
import { Client, makeClient } from './helpers/client.js';
import { createFixture, Fixture } from './helpers/fixtures.js';

/**
 * Calculated payroll, end to end, for a finished month with known facts.
 *
 * March 2026 has 31 days and five Sundays (1, 8, 15, 22, 29), and the company holiday on Friday 20 March leaves 25 working days.
 * So the pay of one day is base pay / 25, and the figures below can be checked by hand.
 */
let app: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;
let api: Client;
const t: Record<string, string> = {};
const MONTH = '2026-03';
const HOLIDAY = '2026-03-20';

const workingDates = (): string[] => {
  const out: string[] = [];
  for (let d = 1; d <= 31; d++) {
    const date = `${MONTH}-${String(d).padStart(2, '0')}`;
    if (new Date(`${date}T00:00:00Z`).getUTCDay() !== 0 && date !== HOLIDAY) out.push(date);
  }
  return out;
};
const DAYS = workingDates();

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  app = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500' });
  api = makeClient(app, fx);
  t.sa = await api.signIn('super');
  for (const name of ['admin', 'admin2', 'in1', 'in2', 'in3', 'in4', 'counsellor2']) t[name] = await api.signIn(name, { office: true });
  await seed();
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.end();
});

const q = (text: string, params?: unknown[]) => owner.query(text, params);
const errorCode = (res: { json: () => { error?: { code?: string } } }) => res.json().error?.code;
const idOf = (who: string) => fx.user(who).id;

async function attend(who: string, date: string, o: { late?: number; workedMinutes?: number } = {}): Promise<string> {
  const { rows } = await q(
    `INSERT INTO attendance_records (tenant_id, user_id, work_date, check_in_at, check_out_at, method, late_minutes, check_out_reason)
     VALUES ($1, $2, $3::date, ($3::date + time '10:00') AT TIME ZONE 'Asia/Kolkata',
             ($3::date + time '10:00') AT TIME ZONE 'Asia/Kolkata' + make_interval(mins => $4), 'office_check', $5, 'shift_end') RETURNING id`,
    [fx.tenantId, idOf(who), date, o.workedMinutes ?? 540, o.late ?? 0],
  );
  return rows[0].id as string;
}

async function leave(who: string, typeName: string, date: string) {
  const type = (await q(`SELECT id FROM leave_types WHERE tenant_id = $1 AND name = $2`, [fx.tenantId, typeName])).rows[0].id;
  await q(
    `INSERT INTO leave_requests (tenant_id, user_id, leave_type_id, from_date, to_date, days, status, decided_by, decided_at)
     VALUES ($1, $2, $3, $4::date, $4::date, 1, 'approved', $5, now())`,
    [fx.tenantId, idOf(who), type, date, idOf('admin')],
  );
}

/** Known attendance for March 2026. */
async function seed() {
  await q(
    `INSERT INTO attendance_settings (tenant_id, effective_from, shift_start, shift_end, grace_minutes, half_day_below_hours, idle_timeout_min, weekly_off_days)
     VALUES ($1, '2020-01-01', '10:00', '19:00', 10, 4.5, 30, '{0}')`,
    [fx.tenantId],
  );
  await q(`INSERT INTO holidays (tenant_id, holiday_date, name) VALUES ($1, $2, 'Company holiday')`, [fx.tenantId, HOLIDAY]);

  // in1: every working day, one lunch that ran ten minutes over its 45 minutes.
  const first: string[] = [];
  for (const d of DAYS) first.push(await attend('in1', d));
  const lunch = (await q(`SELECT id FROM break_types WHERE tenant_id = $1 AND name = 'Lunch'`, [fx.tenantId])).rows[0].id;
  await q(
    `INSERT INTO break_logs (tenant_id, attendance_id, break_type_id, started_at, ended_at)
     VALUES ($1, $2, $3, '2026-03-03 13:00+05:30', '2026-03-03 13:55+05:30')`,
    [fx.tenantId, first[DAYS.indexOf('2026-03-03')], lunch],
  );

  // in2: absent on 2 and 3 March, a half day on the 4th, and five late arrivals on the 5th, 6th, 7th, 9th and 10th.
  for (const d of DAYS) {
    if (d === '2026-03-02' || d === '2026-03-03') continue;
    await attend('in2', d, { workedMinutes: d === '2026-03-04' ? 200 : 540, late: ['2026-03-05', '2026-03-06', '2026-03-07', '2026-03-09', '2026-03-10'].includes(d) ? 15 : 0 });
  }

  // in3: paid leave on the 11th, unpaid leave on the 12th, in on every other day.
  await leave('in3', 'Casual Leave', '2026-03-11');
  await leave('in3', 'Unpaid Leave', '2026-03-12');
  for (const d of DAYS) if (d !== '2026-03-11' && d !== '2026-03-12') await attend('in3', d);

  for (const who of ['counsellor2', 'admin']) for (const d of DAYS) await attend(who, d);
}

const structure = (who: string, basePay: number, extra: Record<string, unknown> = {}) => ({ userId: idOf(who), effectiveFrom: MONTH, basePay, allowances: [], deductions: [], ...extra });
const putStructure = (token: string, body: unknown) => api.call('PUT', '/salary-structures', token, body as never);
const run = async (token: string, id: string) => (await api.call('GET', `/payroll/runs/${id}`, token)).json();
const slipOf = (detail: { payslips: { id: string; user: { name: string } }[] }, who: string) => detail.payslips.find((p) => p.user.name === who)!;
const lineOf = (slip: { lines: { id: string; label: string }[] }, label: string) => slip.lines.find((l) => l.label === label)!;
let runId = '';

describe('the payroll policy', () => {
  it('starts as the proposal made to the client, until the company saves its own', async () => {
    const res = await api.call('GET', '/payroll/policy', t.sa!);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().current).toMatchObject({ isDefault: true, effectiveFrom: null, workingDaysBasis: 'working', lateFreePerMonth: 3, latePenaltyDays: 0.25, absentDeductionDays: 1, breakOverrunPerMinute: 0 });
  });

  it('can be read by someone who sees salaries, and changed only by someone who manages payroll', async () => {
    expect((await api.call('GET', '/payroll/policy', t.admin!)).statusCode).toBe(200);
    expect((await api.call('GET', '/payroll/policy', t.in1!)).statusCode).toBe(403);
    const body = { effectiveFrom: MONTH, workingDaysBasis: 'working', lateFreePerMonth: 3, latePenaltyDays: 0.25, halfDayDeductionDays: 0.5, absentDeductionDays: 1, unpaidLeaveDeductionDays: 1, breakOverrunPerMinute: 2 };
    expect((await api.call('PUT', '/payroll/policy', t.admin!, body)).statusCode).toBe(403);
    const saved = await api.call('PUT', '/payroll/policy', t.sa!, body);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ effectiveFrom: MONTH, breakOverrunPerMinute: 2, isDefault: false });
    const log = (await q(`SELECT actor_id, after FROM audit_logs WHERE tenant_id = $1 AND action = 'payroll.policy_change'`, [fx.tenantId])).rows;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actor_id: idOf('super'), after: { breakOverrunPerMinute: 2 } });
  });

  it('refuses values that make no sense', async () => {
    const base = { effectiveFrom: MONTH, workingDaysBasis: 'working', lateFreePerMonth: 3, latePenaltyDays: 0.25, halfDayDeductionDays: 0.5, absentDeductionDays: 1, unpaidLeaveDeductionDays: 1, breakOverrunPerMinute: 0 };
    for (const bad of [{ effectiveFrom: 'March' }, { workingDaysBasis: 'weekly' }, { absentDeductionDays: 9 }, { latePenaltyDays: 0.1 }, { lateFreePerMonth: -1 }, { halfDayDeductionDays: 1.5 }]) {
      const res = await api.call('PUT', '/payroll/policy', t.sa!, { ...base, ...bad });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
  });
});

describe('salary structures', () => {
  it('are set by an Admin for their own team, with named allowances and deductions', async () => {
    const res = await putStructure(t.admin!, structure('in1', 30000, { allowances: [{ label: 'HRA', amount: 6000 }], deductions: [{ label: 'PF', amount: 1800 }], notes: 'Joined 2025' }));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ basePay: 30000, effectiveFrom: MONTH, allowances: [{ label: 'HRA', amount: 6000 }], deductions: [{ label: 'PF', amount: 1800 }], user: { name: 'in1' } });
    expect((await putStructure(t.admin!, structure('in2', 26000))).statusCode).toBe(200);
    expect((await putStructure(t.admin!, structure('in3', 26000))).statusCode).toBe(200);
    expect((await putStructure(t.sa!, structure('counsellor2', 20000))).statusCode).toBe(200);
    expect((await putStructure(t.sa!, structure('admin', 40000))).statusCode).toBe(200);
  });

  it('keep the old version when a new one is saved for the same month, and say who changed what', async () => {
    const again = await putStructure(t.admin!, structure('in1', 30000, { allowances: [{ label: 'HRA', amount: 6000 }], deductions: [{ label: 'PF', amount: 1800 }], notes: 'Joined 2025 (checked)' }));
    expect(again.json().notes).toBe('Joined 2025 (checked)');
    const history = await api.call('GET', `/salary-structures/${idOf('in1')}/history`, t.admin!);
    expect(history.json()).toHaveLength(1);
    const log = (await q(`SELECT action, before, after FROM audit_logs WHERE tenant_id = $1 AND entity = 'salary_structure' AND entity_id = $2 ORDER BY id`, [fx.tenantId, again.json().id])).rows;
    expect(log.map((l) => l.action)).toEqual(['salary_structure.create', 'salary_structure.update']);
    expect(log[1]!.before.notes).toBe('Joined 2025');
  });

  it('refuse a list where the same name appears twice, or deductions above the pay', async () => {
    const twice = await putStructure(t.admin!, structure('in4', 20000, { allowances: [{ label: 'HRA', amount: 1 }, { label: 'hra', amount: 2 }] }));
    expect(errorCode(twice)).toBe('LABEL_REPEATED');
    const over = await putStructure(t.admin!, structure('in4', 1000, { deductions: [{ label: 'PF', amount: 1500 }] }));
    expect(errorCode(over)).toBe('NET_NEGATIVE');
    expect((await putStructure(t.admin!, structure('in4', -5))).statusCode).toBe(400);
  });

  it('stay inside the reach of the person setting them, and are never set by the person themselves', async () => {
    expect((await putStructure(t.admin!, structure('counsellor2', 1))).statusCode).toBe(404);
    expect(errorCode(await putStructure(t.admin!, structure('admin', 1)))).toBe('OWN_SALARY');
    expect((await putStructure(t.in1!, structure('in1', 99999))).statusCode).toBe(403);
    const list = (await api.call('GET', `/salary-structures?month=${MONTH}`, t.admin!)).json();
    const names = list.people.map((p: { user: { name: string } }) => p.user.name);
    expect(names).toContain('in1');
    expect(names).not.toContain('counsellor2');
    expect(list.people.find((p: { user: { name: string } }) => p.user.name === 'in4').structure).toBeNull();
  });
});

describe('calculating a month', () => {
  it('works only for a finished month, and gives a clear error for a bad one', async () => {
    const thisMonth = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
    expect(errorCode(await api.call('POST', '/payroll/runs', t.sa!, { month: thisMonth }))).toBe('MONTH_NOT_FINISHED');
    expect(errorCode(await api.call('POST', '/payroll/runs', t.sa!, { month: '2099-01' }))).toBe('MONTH_NOT_FINISHED');
    expect(errorCode(await api.call('POST', '/payroll/runs', t.sa!, { month: 'March' }))).toBe('MONTH_INVALID');
    expect((await api.call('POST', '/payroll/runs', t.admin!, { month: MONTH })).statusCode).toBe(403);
  });

  it('gives each person the payslip the rules work out from their month', async () => {
    const res = await api.call('POST', '/payroll/runs', t.sa!, { month: MONTH });
    expect(res.statusCode, res.body).toBe(201);
    const detail = res.json();
    runId = detail.id;
    expect(detail).toMatchObject({ month: MONTH, status: 'draft', people: 5, gross: 148000, deductions: 5980, netPay: 142020, policy: { breakOverrunPerMinute: 2 } });

    const slip = async (who: string) => (await api.call('GET', `/payroll/payslips/${slipOf(detail, who).id}`, t.sa!)).json();
    const in1 = await slip('in1');
    expect(in1).toMatchObject({ gross: 36000, deductions: 1820, netPay: 34180, presentDays: 25, absentDays: 0, facts: { workingDays: 25, basisDays: 25 } });
    expect(in1.lines.map((l: { label: string; amount: number }) => [l.label, l.amount])).toEqual([['Base pay', 30000], ['HRA', 6000], ['PF', 1800], ['Break overrun', 20]]);

    const in2 = await slip('in2');
    expect(in2).toMatchObject({ netPay: 22880, presentDays: 23, absentDays: 2, lateCount: 5, facts: { halfDays: 1, dailyRate: 1040 } });
    expect(in2.lines.filter((l: { kind: string }) => l.kind === 'deduction').map((l: { label: string; amount: number }) => [l.label, l.amount])).toEqual([
      ['Absent without leave', 2080], ['Half days', 520], ['Late arrivals', 520],
    ]);

    expect(await slip('in3')).toMatchObject({ netPay: 24960, absentDays: 0, facts: { paidLeaveDays: 1, unpaidLeaveDays: 1 } });
    expect(await slip('counsellor2')).toMatchObject({ netPay: 20000 });
  });

  it('lists people who have no salary structure yet instead of leaving them out silently', async () => {
    const names = (await run(t.sa!, runId)).missingStructure.map((p: { name: string }) => p.name);
    expect(names).toContain('in4');
    expect(names).not.toContain('in1');
  });

  it('refuses a second run for the same month', async () => {
    expect(errorCode(await api.call('POST', '/payroll/runs', t.sa!, { month: MONTH }))).toBe('RUN_EXISTS');
  });

  it('shows an Admin only their team, and not their own payslip before it is approved', async () => {
    const seen = await run(t.admin!, runId);
    expect(seen.payslips.map((p: { user: { name: string } }) => p.user.name).sort()).toEqual(['in1', 'in2', 'in3']);
    expect(seen).toMatchObject({ people: 3, gross: 88000, deductions: 5980, netPay: 82020 });
  });
});

const randomLineId = '00000000-0000-4000-8000-000000000000';

describe('adjusting a draft', () => {
  let slip: { id: string; lines: { id: string; label: string; amount: number }[] };
  const load = async () => (slip = (await api.call('GET', `/payroll/payslips/${slipOf(await run(t.sa!, runId), 'in2').id}`, t.sa!)).json());
  const lineUrl = (lineId?: string) => `/payroll/payslips/${slip.id}/lines${lineId ? `/${lineId}` : ''}`;

  it('lets an Admin change a line of their team, only with a reason, and keeps the calculated figure beside it', async () => {
    await load();
    const absent = lineOf(slip, 'Absent without leave');
    expect((await api.call('PATCH', lineUrl(absent.id), t.admin!, { amount: 1040 })).statusCode).toBe(400);
    expect((await api.call('PATCH', lineUrl(absent.id), t.admin!, { amount: 1040, reason: 'ok' })).statusCode).toBe(400);
    const res = await api.call('PATCH', lineUrl(absent.id), t.admin!, { amount: 1040, reason: 'One of the two days was an approved site visit' });
    expect(res.statusCode, res.body).toBe(200);
    const after = res.json();
    expect(after).toMatchObject({ deductions: 2080, netPay: 23920, adjusted: true });
    expect(lineOf(after, 'Absent without leave')).toMatchObject({ amount: 1040, calculated: 2080, reason: 'One of the two days was an approved site visit', adjustedBy: 'admin', source: 'attendance' });
    const log = (await q(`SELECT actor_id, before, after FROM audit_logs WHERE tenant_id = $1 AND action = 'payroll.line_adjust'`, [fx.tenantId])).rows;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actor_id: idOf('admin'), before: { amount: 2080 }, after: { amount: 1040, reason: 'One of the two days was an approved site visit', employee: 'in2' } });
  });

  it('adds an extra line with a reason, and removes only a line that someone added', async () => {
    await load();
    expect((await api.call('POST', lineUrl(), t.admin!, { kind: 'deduction', label: 'Advance recovery', amount: 500 })).statusCode).toBe(400);
    const added = await api.call('POST', lineUrl(), t.admin!, { kind: 'deduction', label: 'Advance recovery', amount: 500, reason: 'Advance taken on 2 March' });
    expect(added.statusCode, added.body).toBe(201);
    expect(added.json()).toMatchObject({ deductions: 2580, netPay: 23420 });
    const extra = lineOf(added.json(), 'Advance recovery');
    expect(extra).toMatchObject({ source: 'adjustment', calculated: 0 });
    expect(errorCode(await api.call('DELETE', lineUrl(lineOf(added.json(), 'Half days').id), t.admin!))).toBe('LINE_NOT_REMOVABLE');
    const removed = await api.call('DELETE', lineUrl(extra.id), t.admin!);
    expect(removed.json()).toMatchObject({ deductions: 2080, netPay: 23920 });
  });

  it('can waive a calculated line by setting it to 0 with a reason', async () => {
    await load();
    const res = await api.call('PATCH', lineUrl(lineOf(slip, 'Late arrivals').id), t.admin!, { amount: 0, reason: 'Metro was shut that week' });
    expect(res.json()).toMatchObject({ deductions: 1560, netPay: 24440 });
  });

  it('stays inside the reach of the person adjusting, and never lets people adjust their own', async () => {
    const other = slipOf(await run(t.sa!, runId), 'counsellor2');
    expect((await api.call('PATCH', `/payroll/payslips/${other.id}/lines/${randomLineId}`, t.admin!, { amount: 1, reason: 'not mine' })).statusCode).toBe(404);
    await load();
    expect((await api.call('PATCH', lineUrl(lineOf(slip, 'Base pay').id), t.in2!, { amount: 99999, reason: 'a raise' })).statusCode).toBe(403);
  });

  it('keeps an adjusted payslip when the run is calculated again, unless asked to discard the adjustments', async () => {
    const kept = await api.call('POST', `/payroll/runs/${runId}/recalculate`, t.sa!, {});
    expect(kept.statusCode, kept.body).toBe(200);
    expect(kept.json().keptAdjusted).toBe(1);
    expect(slipOf(kept.json(), 'in2')).toMatchObject({ netPay: 24440, adjusted: true });
    expect((await api.call('POST', `/payroll/runs/${runId}/recalculate`, t.admin!, {})).statusCode).toBe(403);

    const reset = await api.call('POST', `/payroll/runs/${runId}/recalculate`, t.sa!, { discardAdjustments: true });
    expect(reset.json().keptAdjusted).toBe(0);
    expect(slipOf(reset.json(), 'in2')).toMatchObject({ netPay: 22880, adjusted: false });
    expect(reset.json()).toMatchObject({ people: 5, netPay: 142020 });
  });

  it('picks up a changed structure when calculated again', async () => {
    expect((await putStructure(t.admin!, structure('in2', 26000, { allowances: [{ label: 'Conveyance', amount: 1000 }] }))).statusCode).toBe(200);
    const res = await api.call('POST', `/payroll/runs/${runId}/recalculate`, t.sa!, {});
    expect(slipOf(res.json(), 'in2')).toMatchObject({ gross: 27000, netPay: 23880 });
    await putStructure(t.admin!, structure('in2', 26000));
    const back = await api.call('POST', `/payroll/runs/${runId}/recalculate`, t.sa!, {});
    expect(slipOf(back.json(), 'in2')).toMatchObject({ gross: 26000, netPay: 22880 });
  });
});

describe('approving', () => {
  const mine = async (who: string) => (await api.call('GET', '/salaries/mine', t[who]!)).json() as { id: string; basePay: number; allowances: number; deductions: number; netPay: number }[];

  it('is refused while a payslip would pay less than zero', async () => {
    const in3 = (await api.call('GET', `/payroll/payslips/${slipOf(await run(t.sa!, runId), 'in3').id}`, t.sa!)).json();
    const base = lineOf(in3, 'Base pay');
    expect((await api.call('PATCH', `/payroll/payslips/${in3.id}/lines/${base.id}`, t.admin!, { amount: 500, reason: 'Unpaid month' })).json().netPay).toBe(-540);
    const res = await api.call('POST', `/payroll/runs/${runId}/approve`, t.sa!);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({ code: 'NET_NEGATIVE', details: { people: ['in3'] } });
    // Setting the line back to what the rules calculated clears the adjustment altogether.
    const fixed = await api.call('PATCH', `/payroll/payslips/${in3.id}/lines/${base.id}`, t.admin!, { amount: 26000, reason: 'Corrected' });
    expect(fixed.json()).toMatchObject({ netPay: 24960, adjusted: false });
    expect(lineOf(fixed.json(), 'Base pay')).toMatchObject({ reason: null, adjustedBy: null });
  });

  it('is for the Super Admin only, and shows nothing to the employees before it happens', async () => {
    expect(await mine('in1')).toEqual([]);
    expect((await api.call('POST', `/payroll/runs/${runId}/approve`, t.admin!)).statusCode).toBe(403);
    const own = slipOf(await run(t.sa!, runId), 'in1');
    expect((await api.call('GET', `/payroll/payslips/${own.id}`, t.in1!)).statusCode).toBe(404);
  });

  it('locks the run and gives each employee their salary record and payslip', async () => {
    const res = await api.call('POST', `/payroll/runs/${runId}/approve`, t.sa!);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: 'approved', approvedBy: 'super', people: 5, netPay: 142020 });
    const records = await mine('in1');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ basePay: 30000, allowances: 6000, deductions: 1820, netPay: 34180 });

    const pdf = await api.call('GET', `/salaries/${records[0]!.id}/payslip.pdf`, t.in1!);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.rawPayload.length).toBeGreaterThan(1500);

    const log = (await q(`SELECT actor_id, after FROM audit_logs WHERE tenant_id = $1 AND action = 'payroll.approve'`, [fx.tenantId])).rows;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actor_id: idOf('super'), after: { month: MONTH, payslips: 5, net: 142020 } });
  });

  it('lets people read their own payslip with its lines, and nobody else\'s', async () => {
    const detail = await run(t.sa!, runId);
    const own = await api.call('GET', `/payroll/payslips/${slipOf(detail, 'in1').id}`, t.in1!);
    expect(own.statusCode).toBe(200);
    expect(own.json().lines.map((l: { label: string }) => l.label)).toEqual(['Base pay', 'HRA', 'PF', 'Break overrun']);
    expect((await api.call('GET', `/payroll/payslips/${slipOf(detail, 'in2').id}`, t.in1!)).statusCode).toBe(404);
    expect((await api.call('GET', `/payroll/payslips/${slipOf(detail, 'admin').id}`, t.admin!)).statusCode).toBe(200);
    expect((await api.call('GET', `/payroll/payslips/${slipOf(detail, 'counsellor2').id}`, t.admin!)).statusCode).toBe(404);
  });

  it('cannot be changed any more: not through the API, and not even directly in the database', async () => {
    const slip = (await api.call('GET', `/payroll/payslips/${slipOf(await run(t.sa!, runId), 'in2').id}`, t.sa!)).json();
    const line = lineOf(slip, 'Absent without leave');
    expect(errorCode(await api.call('PATCH', `/payroll/payslips/${slip.id}/lines/${line.id}`, t.admin!, { amount: 1, reason: 'too late' }))).toBe('PAYROLL_APPROVED');
    expect(errorCode(await api.call('POST', `/payroll/payslips/${slip.id}/lines`, t.admin!, { kind: 'earning', label: 'Bonus', amount: 1, reason: 'too late' }))).toBe('PAYROLL_APPROVED');
    expect(errorCode(await api.call('POST', `/payroll/runs/${runId}/recalculate`, t.sa!, {}))).toBe('PAYROLL_APPROVED');
    await expect(q(`UPDATE payslip_lines SET amount = 1 WHERE id = $1`, [line.id])).rejects.toThrow(/PAYROLL_APPROVED/);
    await expect(q(`DELETE FROM payslips WHERE id = $1`, [slip.id])).rejects.toThrow(/PAYROLL_APPROVED/);
  });

  it('closes the other doors to that month too', async () => {
    const manual = await api.call('PUT', '/salaries', t.sa!, { userId: idOf('in4'), month: MONTH, basePay: 1000 });
    expect(errorCode(manual)).toBe('PAYROLL_RUN_EXISTS');
    expect(errorCode(await putStructure(t.admin!, structure('in1', 31000)))).toBe('PAYROLL_APPROVED');
    const policy = { effectiveFrom: MONTH, workingDaysBasis: 'calendar', lateFreePerMonth: 0, latePenaltyDays: 1, halfDayDeductionDays: 1, absentDeductionDays: 1, unpaidLeaveDeductionDays: 1, breakOverrunPerMinute: 0 };
    expect(errorCode(await api.call('PUT', '/payroll/policy', t.sa!, policy))).toBe('POLICY_AFFECTS_APPROVED_RUN');
    expect((await api.call('PUT', '/payroll/policy', t.sa!, { ...policy, effectiveFrom: '2026-04' })).statusCode).toBe(200);
  });
});

describe('reopening', () => {
  const mine = async (who: string) => (await api.call('GET', '/salaries/mine', t[who]!)).json() as { netPay: number }[];

  it('needs the right to approve and a reason, and says so in the audit log', async () => {
    expect((await api.call('POST', `/payroll/runs/${runId}/reopen`, t.admin!, { reason: 'Because' })).statusCode).toBe(403);
    expect((await api.call('POST', `/payroll/runs/${runId}/reopen`, t.sa!, {})).statusCode).toBe(400);
    expect((await api.call('POST', `/payroll/runs/${runId}/reopen`, t.sa!, { reason: 'x' })).statusCode).toBe(400);
    const res = await api.call('POST', `/payroll/runs/${runId}/reopen`, t.sa!, { reason: 'An approved leave was entered late' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: 'draft', reopenedCount: 1, approvedBy: null });
    const log = (await q(`SELECT actor_id, before, after FROM audit_logs WHERE tenant_id = $1 AND action = 'payroll.reopen'`, [fx.tenantId])).rows;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actor_id: idOf('super'), before: { status: 'approved' }, after: { status: 'draft', reason: 'An approved leave was entered late', hiddenSalaryRecords: 5 } });
  });

  it('hides the payslips from the employees until it is approved again', async () => {
    expect(await mine('in1')).toEqual([]);
    const own = slipOf(await run(t.sa!, runId), 'in1');
    expect((await api.call('GET', `/payroll/payslips/${own.id}`, t.in1!)).statusCode).toBe(404);
    expect((await api.call('POST', `/payroll/runs/${runId}/reopen`, t.sa!, { reason: 'Again, please' })).statusCode).toBe(409);
  });

  it('can be edited again, and approved again with the corrected figures', async () => {
    const slip = (await api.call('GET', `/payroll/payslips/${slipOf(await run(t.sa!, runId), 'in1').id}`, t.sa!)).json();
    const pf = lineOf(slip, 'PF');
    const edited = await api.call('PATCH', `/payroll/payslips/${slip.id}/lines/${pf.id}`, t.admin!, { amount: 1500, reason: 'PF slab corrected' });
    expect(edited.json()).toMatchObject({ netPay: 34480 });
    expect((await api.call('POST', `/payroll/runs/${runId}/approve`, t.sa!)).statusCode).toBe(200);
    const records = await mine('in1');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ netPay: 34480 });
    expect(Number((await q(`SELECT count(*) FROM salary_records WHERE user_id = $1 AND month = '2026-03-01'`, [idOf('in1')])).rows[0].count)).toBe(1);
  });

  it('lists the runs with their totals for those who may see them', async () => {
    const runs = (await api.call('GET', '/payroll/runs', t.sa!)).json();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ month: MONTH, status: 'approved', reopenedCount: 1, people: 5 });
    expect((await api.call('GET', '/payroll/runs', t.in1!)).statusCode).toBe(403);
    const admins = (await api.call('GET', '/payroll/runs', t.admin!)).json();
    expect(admins[0]).toMatchObject({ people: 4 }); // their team, and their own payslip now that it is approved
  });
});
