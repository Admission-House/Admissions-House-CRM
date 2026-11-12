import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { RetentionService } from '../src/retention/retention.service.js';
import { startApp } from './helpers/app.js';
import { Client, makeClient } from './helpers/client.js';
import { createFixture, Fixture, OFFICE_IP } from './helpers/fixtures.js';

let app: NestFastifyApplication;
let owner: pg.Client;
let appRole: pg.Client;
let fx: Fixture;
let api: Client;
const t: Record<string, string> = {};
let seq = 0;

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  // The restricted role the API itself uses.
  appRole = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await appRole.connect();
  fx = await createFixture(owner);
  app = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500' });
  api = makeClient(app, fx);
  t.sa = await api.signIn('super');
  t.admin = await api.signIn('admin', { office: true });
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await appRole?.end();
  await owner?.end();
});

async function newLead(): Promise<string> {
  const n = ++seq;
  const status = (await owner.query(`SELECT id FROM lead_statuses WHERE tenant_id = $1 ORDER BY sort_order LIMIT 1`, [fx.tenantId])).rows[0].id;
  const { rows } = await owner.query(
    `INSERT INTO leads (tenant_id, lead_no, name, email, primary_phone, status_id, source_id, interest_note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'wants BTech') RETURNING id`,
    [fx.tenantId, 8_100_000 + n, `Erase Me ${n}`, `erase${n}@example.com`, `9188${String(20_000_000 + n)}`, status, fx.sourceId('Website')],
  );
  return rows[0].id as string;
}

describe('the lead history cannot be changed by the application role', () => {
  it('refuses UPDATE and DELETE on lead_activities, but allows adding', async () => {
    const lead = await newLead();
    await appRole.query('BEGIN');
    try {
      await appRole.query(`SELECT set_config('app.tenant_id', $1, true)`, [fx.tenantId]);
      await appRole.query(`INSERT INTO lead_activities (tenant_id, lead_id, type, remark) VALUES ($1, $2, 'note', 'hello')`, [fx.tenantId, lead]);
      await expect(appRole.query('SAVEPOINT a').then(() => appRole.query(`UPDATE lead_activities SET remark = 'x' WHERE lead_id = $1`, [lead]))).rejects.toThrow(/permission denied/);
      await appRole.query('ROLLBACK TO SAVEPOINT a');
      await expect(appRole.query(`DELETE FROM lead_activities WHERE lead_id = $1`, [lead])).rejects.toThrow(/permission denied/);
    } finally {
      await appRole.query('ROLLBACK');
    }
  });
});

describe('erasing a student', () => {
  it('removes everything that identifies them and keeps an anonymous row', async () => {
    const lead = await newLead();
    const email = (await owner.query(`SELECT email FROM leads WHERE id = $1`, [lead])).rows[0].email as string;
    await owner.query(`INSERT INTO lead_phones (tenant_id, lead_id, phone) VALUES ($1, $2, '919800000001')`, [fx.tenantId, lead]);
    await owner.query(`INSERT INTO lead_profiles (tenant_id, lead_id, gender) VALUES ($1, $2, 'male')`, [fx.tenantId, lead]);
    await owner.query(`INSERT INTO lead_guardians (tenant_id, lead_id, relation, name, phone) VALUES ($1, $2, 'father', 'Father Name', '919800000002')`, [fx.tenantId, lead]);
    await owner.query(`INSERT INTO lead_activities (tenant_id, lead_id, type, field, old_value, new_value, remark) VALUES ($1, $2, 'field_change', 'email', 'a@b.co', $3, 'spoke to the father')`, [fx.tenantId, lead, email]);
    const key = `${fx.tenantId}/${lead}/${randomUUID()}.pdf`;
    await owner.query(`INSERT INTO lead_documents (tenant_id, lead_id, doc_type, file_key, mime_type, size_bytes) VALUES ($1, $2, 'aadhaar', $3, 'application/pdf', 100)`, [fx.tenantId, lead, key]);
    await owner.query(`INSERT INTO calls (tenant_id, lead_id, direction, provider_call_id, counterparty, started_at, remark) VALUES ($1, $2, 'outgoing', $3, '919188000000', now(), 'asked about fees')`, [fx.tenantId, lead, `c-${randomUUID()}`]);

    const res = await api.call('POST', `/leads/${lead}/erase`, t.sa!);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ filesRemoved: 1 });

    const row = (await owner.query(`SELECT name, email, primary_phone, interest_note, deleted_at FROM leads WHERE id = $1`, [lead])).rows[0];
    expect(row).toMatchObject({ name: 'Erased', email: null, interest_note: null });
    expect(row.primary_phone).toMatch(/^[0-9]{10}$/);
    expect(row.deleted_at).not.toBeNull();
    for (const table of ['lead_phones', 'lead_profiles', 'lead_guardians', 'lead_documents']) {
      expect((await owner.query(`SELECT count(*)::int AS n FROM ${table} WHERE lead_id = $1`, [lead])).rows[0].n, table).toBe(0);
    }
    const history = (await owner.query(`SELECT old_value, new_value, remark, field FROM lead_activities WHERE lead_id = $1`, [lead])).rows as { old_value: string | null; new_value: string | null; remark: string | null; field: string | null }[];
    const old = history.find((h) => h.field === 'email')!;
    expect([old.old_value, old.new_value, old.remark]).toEqual([null, null, null]);
    expect(history.some((h) => h.field === 'erased')).toBe(true);
    const call = (await owner.query(`SELECT counterparty, remark FROM calls WHERE lead_id = $1`, [lead])).rows[0];
    expect(call).toEqual({ counterparty: '0000000000', remark: null });
    const audit = await owner.query(`SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND action = 'lead.erase' AND entity_id = $2`, [fx.tenantId, lead]);
    expect(audit.rows[0].n).toBe(1);
    // It no longer turns up when searching by the old phone number.
    const found = await api.call('GET', `/leads?q=erase`, t.sa!);
    expect(found.json().items.some((i: { id: string }) => i.id === lead)).toBe(false);
  });

  it('is for people who hold lead.erase, and a lead that does not exist is a 404', async () => {
    const lead = await newLead();
    expect((await api.call('POST', `/leads/${lead}/erase`, t.admin!, undefined, OFFICE_IP)).statusCode).toBe(403);
    expect((await api.call('POST', `/leads/${randomUUID()}/erase`, t.sa!)).statusCode).toBe(404);
    expect((await owner.query(`SELECT name FROM leads WHERE id = $1`, [lead])).rows[0].name).not.toBe('Erased');
  });
});

describe('searching', () => {
  it('asks for at least 3 letters, but accepts a lead number', async () => {
    const short = await api.call('GET', '/leads?q=ab', t.sa!);
    expect(short.statusCode).toBe(400);
    expect(short.json().error.code).toBe('SEARCH_TOO_SHORT');
    expect((await api.call('GET', '/leads?q=12', t.sa!)).statusCode).toBe(200);
    expect((await api.call('GET', '/leads?q=abc', t.sa!)).statusCode).toBe(200);
  });
});

describe('bulk status change', () => {
  it('changes many leads in one go and writes each lead\'s history with the old status name', async () => {
    const [a, b] = [await newLead(), await newLead()];
    const closed = (await owner.query(`SELECT id, name FROM lead_statuses WHERE tenant_id = $1 AND is_open = false AND NOT requires_followup LIMIT 1`, [fx.tenantId])).rows[0];
    const res = await api.call('POST', '/leads/bulk/status', t.sa!, { leadIds: [a, b], statusId: closed.id });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ requested: 2, changed: 2 });
    const rows = (await owner.query(`SELECT lead_id, old_value, new_value FROM lead_activities WHERE lead_id = ANY($1::uuid[]) AND type = 'status_change'`, [[a, b]])).rows;
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.new_value).toBe(closed.name);
      expect(r.old_value).toBeTruthy();
    }
  });
});

describe('clearing old technical records', () => {
  it('removes only what is older than the keep time and leaves recent and live rows', async () => {
    const user = fx.user('counsellor').id;
    await owner.query(`INSERT INTO login_attempts (tenant_id, user_id, result, created_at) VALUES ($1, $2, 'success', now() - interval '200 days'), ($1, $2, 'success', now())`, [fx.tenantId, user]);
    const src = fx.sourceId('Website');
    await owner.query(
      `INSERT INTO inbound_events (tenant_id, provider, external_id, payload, status, source_id, received_at) VALUES
         ($1, 'website', 'old-ok', '{}', 'processed', $2, now() - interval '200 days'),
         ($1, 'website', 'old-failed-recent-enough', '{}', 'failed', $2, now() - interval '120 days'),
         ($1, 'website', 'old-failed', '{}', 'failed', $2, now() - interval '200 days'),
         ($1, 'website', 'fresh', '{}', 'processed', $2, now())`,
      [fx.tenantId, src],
    );
    await owner.query(
      `INSERT INTO user_sessions (tenant_id, user_id, refresh_token_hash, expires_at, ended_at, ended_reason) VALUES
         ($1, $2, $3, now() - interval '199 days', now() - interval '200 days', 'logout'),
         ($1, $2, $4, now() + interval '1 day', NULL, NULL)`,
      [fx.tenantId, user, randomUUID(), randomUUID()],
    );
    await owner.query(
      `INSERT INTO password_reset_tokens (tenant_id, user_id, token_hash, expires_at, used_at) VALUES ($1, $2, $3, now() - interval '60 days', NULL), ($1, $2, $4, now() + interval '1 hour', NULL)`,
      [fx.tenantId, user, randomUUID(), randomUUID()],
    );

    const counts = await app.get(RetentionService).runOnce();
    expect(counts.loginAttempts).toBeGreaterThanOrEqual(1);

    const left = async (sqlText: string) => (await owner.query(sqlText, [fx.tenantId])).rows[0].n as number;
    expect(await left(`SELECT count(*)::int AS n FROM login_attempts WHERE tenant_id = $1 AND created_at < now() - interval '90 days'`)).toBe(0);
    expect(await left(`SELECT count(*)::int AS n FROM login_attempts WHERE tenant_id = $1 AND created_at >= now() - interval '1 day'`)).toBeGreaterThanOrEqual(1);
    const events = (await owner.query(`SELECT external_id FROM inbound_events WHERE tenant_id = $1 AND external_id IN ('old-ok','old-failed-recent-enough','old-failed','fresh') ORDER BY external_id`, [fx.tenantId])).rows.map((r) => r.external_id);
    expect(events).toEqual(['fresh', 'old-failed-recent-enough']);
    expect(await left(`SELECT count(*)::int AS n FROM user_sessions WHERE tenant_id = $1 AND ended_at < now() - interval '90 days'`)).toBe(0);
    expect(await left(`SELECT count(*)::int AS n FROM user_sessions WHERE tenant_id = $1 AND ended_at IS NULL AND expires_at > now() + interval '12 hours'`)).toBe(1);
    expect(await left(`SELECT count(*)::int AS n FROM password_reset_tokens WHERE tenant_id = $1`)).toBe(1);
  });
});
