import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';

const BATCH = 5_000;
/** Password-reset links are useless a day after they expire; a month is plenty for investigating abuse. */
const RESET_KEEP_DAYS = 30;

export interface RetentionCounts {
  loginAttempts: number;
  inboundEvents: number;
  sessions: number;
  resetTokens: number;
}

/**
 * Clears technical records that only grow: sign-in attempts, raw website events (which hold the
 * visitor's details), ended sessions and used or expired password-reset links. Business records
 * (leads, calls, attendance, salary, audit log) are never touched here.
 *
 * It runs once a day on every server; an advisory lock per company means only one does the work.
 * Rows go in batches so a large backlog never holds a long lock.
 */
@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetentionService.name);
  private timer?: NodeJS.Timeout;
  private first?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly db: DatabaseService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    if (this.env.RETENTION_INTERVAL_HOURS <= 0) return;
    // A first pass shortly after start, so a server that restarts often still gets cleaned.
    this.first = setTimeout(() => void this.runSafely(), 2 * 60_000);
    this.first.unref();
    this.timer = setInterval(() => void this.runSafely(), this.env.RETENTION_INTERVAL_HOURS * 3_600_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.first) clearTimeout(this.first);
  }

  /** One pass over every active company. Returns what was removed in total. */
  async runOnce(): Promise<RetentionCounts> {
    const total: RetentionCounts = { loginAttempts: 0, inboundEvents: 0, sessions: 0, resetTokens: 0 };
    const { rows: tenants } = await sql<{ id: string }>`SELECT list_active_tenant_ids() AS id`.execute(this.db.unscoped());
    for (const { id } of tenants) {
      const c = await this.purgeTenant(id);
      total.loginAttempts += c.loginAttempts;
      total.inboundEvents += c.inboundEvents;
      total.sessions += c.sessions;
      total.resetTokens += c.resetTokens;
    }
    return total;
  }

  private async purgeTenant(tenantId: string): Promise<RetentionCounts> {
    const days = this.env.RETENTION_KEEP_DAYS;
    const counts: RetentionCounts = { loginAttempts: 0, inboundEvents: 0, sessions: 0, resetTokens: 0 };
    const locked = await this.db.withTenant(tenantId, async (trx) => {
      const { rows } = await sql<{ ok: boolean }>`SELECT pg_try_advisory_xact_lock(hashtext('retention'), hashtext(${tenantId})) AS ok`.execute(trx);
      return rows[0]?.ok ?? false;
    });
    if (!locked) return counts;

    // Each statement is its own short transaction, repeated until a batch comes back short.
    const loop = async (run: (trx: Parameters<Parameters<DatabaseService['withTenant']>[1]>[0]) => Promise<number>): Promise<number> => {
      let removed = 0;
      for (;;) {
        const n = await this.db.withTenant(tenantId, run);
        removed += n;
        if (n < BATCH) return removed;
      }
    };

    counts.loginAttempts = await loop(async (trx) =>
      Number((await sql`DELETE FROM login_attempts WHERE id IN (SELECT id FROM login_attempts WHERE created_at < now() - make_interval(days => ${days}) LIMIT ${BATCH})`.execute(trx)).numAffectedRows ?? 0));

    // A processed event is kept for the agreed time; one that never became a lead is kept twice as long, for investigation.
    counts.inboundEvents = await loop(async (trx) =>
      Number((await sql`DELETE FROM inbound_events WHERE id IN (
          SELECT id FROM inbound_events
           WHERE received_at < now() - make_interval(days => ${days})
             AND (status = 'processed' OR received_at < now() - make_interval(days => ${days * 2}))
           LIMIT ${BATCH})`.execute(trx)).numAffectedRows ?? 0));

    counts.sessions = await loop(async (trx) =>
      Number((await sql`DELETE FROM user_sessions WHERE id IN (
          SELECT id FROM user_sessions WHERE LEAST(COALESCE(ended_at, expires_at), expires_at) < now() - make_interval(days => ${days}) LIMIT ${BATCH})`.execute(trx)).numAffectedRows ?? 0));

    counts.resetTokens = await loop(async (trx) =>
      Number((await sql`DELETE FROM password_reset_tokens WHERE id IN (
          SELECT id FROM password_reset_tokens WHERE COALESCE(used_at, expires_at) < now() - make_interval(days => ${RESET_KEEP_DAYS}) LIMIT ${BATCH})`.execute(trx)).numAffectedRows ?? 0));

    return counts;
  }

  private async runSafely(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const c = await this.runOnce();
      const total = c.loginAttempts + c.inboundEvents + c.sessions + c.resetTokens;
      if (total > 0) this.logger.log(`cleared ${c.loginAttempts} sign-in attempts, ${c.inboundEvents} website events, ${c.sessions} old sessions, ${c.resetTokens} reset links`);
    } catch (err) {
      this.logger.error(`retention failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
  }
}
