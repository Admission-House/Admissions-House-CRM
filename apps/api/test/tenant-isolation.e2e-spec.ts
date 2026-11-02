import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import pg from 'pg';
import { mapError } from '../src/common/error-mapping.js';
import { loadEnv } from '../src/config/env.js';
import { DatabaseService } from '../src/database/database.service.js';

// Real database. The owner connection only prepares and cleans up data; every check runs through
// DatabaseService, which connects as the restricted application role.

const run = randomUUID().slice(0, 8);
const tenantA = randomUUID();
const tenantB = randomUUID();

let owner: pg.Client;
let db: DatabaseService;
let statusA: string;

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();

  for (const [id, key] of [
    [tenantA, 'a'],
    [tenantB, 'b'],
  ] as const) {
    await owner.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [id, `Test ${key}`, `iso-${key}-${run}`]);
    await owner.query(`INSERT INTO lead_statuses (tenant_id, name, queue) VALUES ($1, $2, 'fresh')`, [id, `status-${key}`]);
    await owner.query(`INSERT INTO lead_sources (tenant_id, name, channel_type) VALUES ($1, $2, 'website')`, [id, `source-${key}`]);
  }
  statusA = (await owner.query('SELECT id FROM lead_statuses WHERE tenant_id = $1', [tenantA])).rows[0].id;

  // One connection only, so every query below reuses the same session. That is the worst case
  // for a tenant setting leaking from one request to the next.
  db = new DatabaseService({ ...loadEnv(process.env), DB_POOL_MAX: 1 });
});

afterAll(async () => {
  await db?.onModuleDestroy();
  for (const table of ['leads', 'tenant_counters', 'lead_statuses', 'lead_sources']) {
    await owner.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [[tenantA, tenantB]]);
  }
  await owner.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [[tenantA, tenantB]]);
  await owner.end();
});

describe('tenant isolation', () => {
  it('a request sees only its own company', async () => {
    const a = await db.withTenant(tenantA, (trx) => trx.selectFrom('lead_statuses').select('name').execute());
    const b = await db.withTenant(tenantB, (trx) => trx.selectFrom('lead_statuses').select('name').execute());
    expect(a.map((r) => r.name)).toEqual(['status-a']);
    expect(b.map((r) => r.name)).toEqual(['status-b']);
  });

  it('a connection without a company sees nothing', async () => {
    const rows = await db.unscoped().selectFrom('lead_statuses').select('name').execute();
    expect(rows).toEqual([]);
  });

  it('the company setting does not leak to the next request on the same connection', async () => {
    await db.withTenant(tenantA, (trx) => trx.selectFrom('lead_statuses').select('id').execute());
    const rows = await db.unscoped().selectFrom('lead_statuses').select('id').execute();
    expect(rows).toEqual([]);
  });

  it('a failed transaction leaves nothing behind', async () => {
    await expect(
      db.withTenant(tenantA, async (trx) => {
        await trx.insertInto('lead_statuses').values({ tenant_id: tenantA, name: 'temp', queue: 'fresh' }).execute();
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const rows = await db.withTenant(tenantA, (trx) => trx.selectFrom('lead_statuses').select('name').execute());
    expect(rows.map((r) => r.name)).toEqual(['status-a']);
  });

  it('writing a row that belongs to another company is refused', async () => {
    const attempt = db.withTenant(tenantA, (trx) =>
      trx.insertInto('lead_statuses').values({ tenant_id: tenantB, name: 'intruder', queue: 'fresh' }).execute(),
    );
    const error = await attempt.catch((e: unknown) => e);
    expect(error).toMatchObject({ code: '42501' });
    expect(mapError(error)).toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  it('a lead cannot point at another company\'s status', async () => {
    const source = await db.withTenant(tenantB, (trx) => trx.selectFrom('lead_sources').select('id').executeTakeFirstOrThrow());
    const error = await db
      .withTenant(tenantB, (trx) =>
        trx
          .insertInto('leads')
          .values({
            tenant_id: tenantB,
            lead_no: '1',
            name: 'Cross link',
            primary_phone: '919000000001',
            status_id: statusA, // belongs to company A
            source_id: source.id,
          })
          .execute(),
      )
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: '23503' });
  });

  // The search functions run with the owner's rights so they can use the trigram indexes. They must
  // still never return another company's leads, nor anything when no company is set.
  describe('lead search functions', () => {
    const phoneA = '919777000111';
    const phoneB = '919777000222';
    beforeAll(async () => {
      const src = async (tenant: string) => (await owner.query('SELECT id FROM lead_sources WHERE tenant_id = $1', [tenant])).rows[0].id as string;
      const statusB = (await owner.query('SELECT id FROM lead_statuses WHERE tenant_id = $1', [tenantB])).rows[0].id as string;
      await owner.query(
        `INSERT INTO leads (tenant_id, lead_no, name, email, primary_phone, status_id, source_id) VALUES ($1, 1, $2, $3, $4, $5, $6)`,
        [tenantA, `Zebra Searchable ${run}`, `zebra-${run}@example.com`, phoneA, statusA, await src(tenantA)],
      );
      await owner.query(
        `INSERT INTO leads (tenant_id, lead_no, name, email, primary_phone, status_id, source_id) VALUES ($1, 1, $2, $3, $4, $5, $6)`,
        [tenantB, `Zebra Other ${run}`, `zebra-b-${run}@example.com`, phoneB, statusB, await src(tenantB)],
      );
    });

    const text = (tenant: string | null, pattern: string) => {
      const query = sql<{ id: string }>`SELECT lead_ids_matching_text(${pattern}) AS id`;
      return (tenant ? db.withTenant(tenant, (trx) => query.execute(trx)) : query.execute(db.unscoped())).then((r) => r.rows.length);
    };
    const phone = (tenant: string, pattern: string) =>
      db.withTenant(tenant, (trx) => sql<{ id: string }>`SELECT lead_ids_matching_phone(${pattern}) AS id`.execute(trx)).then((r) => r.rows.length);

    it('finds a lead of the current company by name and by email', async () => {
      expect(await text(tenantA, `%Zebra Searchable ${run}%`)).toBe(1);
      expect(await text(tenantA, `%zebra-${run}@%`)).toBe(1);
    });

    it('never returns the other company\'s leads for the same search', async () => {
      // "Zebra" matches one lead in each company; each company sees only its own.
      expect(await text(tenantA, `%${run}%`)).toBe(1);
      expect(await text(tenantB, `%${run}%`)).toBe(1);
      expect(await text(tenantA, `%Zebra Other ${run}%`)).toBe(0);
      expect(await phone(tenantA, `%${phoneB}%`)).toBe(0);
      expect(await phone(tenantB, `%${phoneB}%`)).toBe(1);
    });

    it('returns nothing when no company is set', async () => {
      expect(await text(null, `%${run}%`)).toBe(0);
    });
  });

  it('rejects a tenant id that is not a uuid before touching the database', async () => {
    await expect(db.withTenant("x'; DROP TABLE leads; --", async () => 1)).rejects.toThrow(/valid tenant id/);
  });

  it('keeps calendar dates as plain strings', async () => {
    const rows = await db.withTenant(tenantA, (trx) =>
      trx.selectFrom('attendance_records').select('work_date').limit(1).execute(),
    );
    expect(rows).toEqual([]);
    const result = await db.unscoped().selectNoFrom((eb) => eb.cast<string>(eb.val('2026-10-27'), 'date').as('d')).executeTakeFirstOrThrow();
    expect(result.d).toBe('2026-10-27');
  });
});
