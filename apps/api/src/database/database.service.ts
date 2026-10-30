import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Kysely, PostgresDialect, sql, Transaction } from 'kysely';
import { Pool, types } from 'pg';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import type { DB } from './db.js';

export type Trx = Transaction<DB>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PG_DATE_OID = 1082;

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly pool: Pool;
  private readonly db: Kysely<DB>;

  constructor(@Inject(ENV) env: Env) {
    this.pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: env.DB_POOL_MAX,
      application_name: 'ah-api',
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: env.DB_STATEMENT_TIMEOUT_MS,
      // A request that crashes mid-transaction must not hold locks for long.
      idle_in_transaction_session_timeout: 30_000,
      types: {
        getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
          // A calendar date has no time zone. Keep it as 'YYYY-MM-DD' instead of a Date, which
          // would shift the day on a server that is not in the same zone as the company.
          oid === PG_DATE_OID
            ? (value: string) => value
            : types.getTypeParser(oid, format)) as typeof types.getTypeParser,
      },
    });
    this.pool.on('error', (err) => this.logger.error(`idle database client error: ${err.message}`));
    this.db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: this.pool }) });
  }

  /**
   * Runs `work` in one transaction that is limited to a single company. The company is set with
   * set_config(..., true), which lasts only until the transaction ends, so a pooled connection can
   * never carry one company's id into another request. Row-level security does the rest.
   */
  async withTenant<T>(tenantId: string, work: (trx: Trx) => Promise<T>): Promise<T> {
    if (!UUID.test(tenantId)) throw new Error('withTenant needs a valid tenant id');
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
      return work(trx);
    });
  }

  /**
   * A connection with no company set. Row-level security makes every tenant table look empty to it,
   * so it is only useful for the SECURITY DEFINER lookups that must run before a company is known
   * (find_tenant_by_slug, resolve_api_key, ensure_partitions).
   */
  unscoped(): Kysely<DB> {
    return this.db;
  }

  async ping(): Promise<void> {
    await sql`SELECT 1`.execute(this.db);
  }

  async onModuleDestroy(): Promise<void> {
    await this.db.destroy();
  }
}
