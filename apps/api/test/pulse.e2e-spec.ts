import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { startApp } from './helpers/app.js';
import { Client, makeClient } from './helpers/client.js';
import { createFixture, Fixture, OFFICE_IP } from './helpers/fixtures.js';

let app: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;
let other: Fixture;
let api: Client;
const t: Record<string, string> = {};

const pulse = async (token: string) => {
  const res = await api.call(
    'GET',
    '/realtime/pulse',
    token,
    undefined,
    token === t.sa ? undefined : OFFICE_IP,
  );
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { stamps: Record<string, string>; ringing: boolean };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  other = await createFixture(owner);
  app = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500' });
  api = makeClient(app, fx);
  t.sa = await api.signIn('super');
  t.lc = await api.signIn('counsellor', { office: true });
  t.lc2 = await api.signIn('counsellor2', { office: true });
});

afterAll(async () => {
  await app?.close();
  await other?.cleanup();
  await fx?.cleanup();
  await owner?.end();
});

describe('the question "what changed since last time?"', () => {
  it('is answered only for someone signed in', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/realtime/pulse',
      remoteAddress: '198.51.100.40',
    });
    expect(res.statusCode).toBe(401);
  });

  it('shows when the leads last changed, and moves on when a lead is added', async () => {
    const before = (await pulse(t.sa!)).stamps.lead;
    await sleep(20);
    const status = (
      await owner.query(
        `SELECT id FROM lead_statuses WHERE tenant_id = $1 ORDER BY sort_order LIMIT 1`,
        [fx.tenantId],
      )
    ).rows[0].id;
    // A write made inside the company's own context, the way the API does it.
    await owner.query('BEGIN');
    await owner.query(`SELECT set_config('app.tenant_id', $1, true)`, [fx.tenantId]);
    await owner.query(
      `INSERT INTO leads (tenant_id, lead_no, name, primary_phone, status_id, source_id) VALUES ($1, 9100001, 'Pulse Lead', '9111100001', $2, $3)`,
      [fx.tenantId, status, fx.sourceId('Website')],
    );
    await owner.query('COMMIT');
    const after = (await pulse(t.sa!)).stamps.lead;
    expect(after).toBeDefined();
    expect(before === undefined || new Date(after!) > new Date(before)).toBe(true);
  });

  it('tells everyone when anything about a lead changes, not only its status, and when work or company settings change', async () => {
    const lead = (
      await owner.query(`SELECT id FROM leads WHERE tenant_id = $1 AND lead_no = 9100001`, [
        fx.tenantId,
      ])
    ).rows[0].id;
    const inCompany = async (statement: string, args: unknown[]) => {
      await owner.query('BEGIN');
      await owner.query(`SELECT set_config('app.tenant_id', $1, true)`, [fx.tenantId]);
      await owner.query(statement, args);
      await owner.query('COMMIT');
    };
    // A note-only change to a lead that nobody holds: a counsellor's screen must still hear about it.
    const before = (await pulse(t.lc!)).stamps;
    await sleep(20);
    await inCompany(`UPDATE leads SET name = 'Pulse Lead edited' WHERE id = $1`, [lead]);
    const afterLead = (await pulse(t.lc!)).stamps;
    expect(new Date(afterLead.lead!) > new Date(before.lead ?? 0)).toBe(true);
    await sleep(20);
    await inCompany(`UPDATE break_types SET name = name WHERE tenant_id = $1`, [fx.tenantId]);
    expect((await pulse(t.lc!)).stamps.admin).toBeDefined();
    await inCompany(
      `UPDATE attendance_records SET late_minutes = late_minutes WHERE tenant_id = $1`,
      [fx.tenantId],
    );
    expect((await pulse(t.sa!)).stamps.work).toBeDefined();
  });

  it('tells everyone, not only the person on the call, when a call starts or ends (call lists and call reports)', async () => {
    const before = {
      sa: (await pulse(t.sa!)).stamps.calllog,
      lc2: (await pulse(t.lc2!)).stamps.calllog,
    };
    await sleep(20);
    await owner.query('BEGIN');
    await owner.query(`SELECT set_config('app.tenant_id', $1, true)`, [fx.tenantId]);
    const { rows } = await owner.query(
      `INSERT INTO calls (tenant_id, direction, provider_call_id, counterparty, started_at, outcome) VALUES ($1, 'incoming', 'pulse-call-1', '919811100099', now(), 'ringing') RETURNING id, started_at`,
      [fx.tenantId],
    );
    await owner.query('COMMIT');
    const started = {
      sa: (await pulse(t.sa!)).stamps.calllog,
      lc2: (await pulse(t.lc2!)).stamps.calllog,
    };
    for (const who of ['sa', 'lc2'] as const) {
      expect(started[who], who).toBeDefined();
      expect(before[who] === undefined || new Date(started[who]!) > new Date(before[who]!)).toBe(
        true,
      );
    }
    await sleep(20);
    await owner.query('BEGIN');
    await owner.query(`SELECT set_config('app.tenant_id', $1, true)`, [fx.tenantId]);
    await owner.query(`UPDATE calls SET outcome = 'missed', ended_at = now() WHERE id = $1`, [
      rows[0].id,
    ]);
    await owner.query('COMMIT');
    expect(new Date((await pulse(t.lc2!)).stamps.calllog!) > new Date(started.lc2!)).toBe(true);
    // The other company hears nothing.
    expect(
      (await pulse(await makeClient(app, other).signIn('super'))).stamps.calllog,
    ).toBeUndefined();
  });

  it("keeps one person's notifications to that person", async () => {
    const mine = (await pulse(t.lc!)).stamps.notification;
    const theirs = (await pulse(t.lc2!)).stamps.notification;
    await sleep(20);
    await owner.query('BEGIN');
    await owner.query(`SELECT set_config('app.tenant_id', $1, true)`, [fx.tenantId]);
    await owner.query(
      `INSERT INTO notifications (tenant_id, user_id, type, payload) VALUES ($1, $2, 'communication', '{"event":"comm_missed"}'::jsonb)`,
      [fx.tenantId, fx.user('counsellor').id],
    );
    await owner.query('COMMIT');
    const mineAfter = (await pulse(t.lc!)).stamps.notification;
    expect(mineAfter).toBeDefined();
    expect(mine === undefined || new Date(mineAfter!) > new Date(mine)).toBe(true);
    expect((await pulse(t.lc2!)).stamps.notification).toBe(theirs); // the other counsellor sees no change
  });

  it("never shows another company's changes", async () => {
    await owner.query('BEGIN');
    await owner.query(`SELECT set_config('app.tenant_id', $1, true)`, [other.tenantId]);
    const status = (
      await owner.query(
        `SELECT id FROM lead_statuses WHERE tenant_id = $1 ORDER BY sort_order LIMIT 1`,
        [other.tenantId],
      )
    ).rows[0].id;
    await owner.query(
      `INSERT INTO leads (tenant_id, lead_no, name, primary_phone, status_id, source_id) VALUES ($1, 9100002, 'Other Co Lead', '9111100002', $2, $3)`,
      [other.tenantId, status, other.sourceId('Website')],
    );
    await owner.query('COMMIT');
    const mine = await owner.query(
      `SELECT count(*)::int n FROM live_stamps WHERE tenant_id = $1 AND topic = 'lead'`,
      [fx.tenantId],
    );
    const theirs = await owner.query(
      `SELECT count(*)::int n FROM live_stamps WHERE tenant_id = $1 AND topic = 'lead'`,
      [other.tenantId],
    );
    expect(theirs.rows[0].n).toBe(1);
    expect(mine.rows[0].n).toBe(1);
    // And a person of the first company asking never gets the second company's stamp.
    const res = await pulse(t.sa!);
    const own = (
      await owner.query(
        `SELECT bumped_at FROM live_stamps WHERE tenant_id = $1 AND topic = 'lead'`,
        [fx.tenantId],
      )
    ).rows[0].bumped_at as Date;
    expect(res.stamps.lead).toBe(own.toISOString());
  });

  it('a change that cannot be stamped (no company set) still goes through', async () => {
    // Made with no company context at all: the stamp is refused by the company rule, and the lead is saved anyway.
    const status = (
      await owner.query(
        `SELECT id FROM lead_statuses WHERE tenant_id = $1 ORDER BY sort_order LIMIT 1`,
        [fx.tenantId],
      )
    ).rows[0].id;
    const r = await owner
      .query(
        `INSERT INTO leads (tenant_id, lead_no, name, primary_phone, status_id, source_id) VALUES ($1, 9100003, 'No Context Lead', '9111100003', $2, $3) RETURNING id`,
        [fx.tenantId, status, fx.sourceId('Website')],
      )
      .catch((e: Error) => e);
    expect(r instanceof Error ? r.message : 'ok').toBe('ok');
  });
});
