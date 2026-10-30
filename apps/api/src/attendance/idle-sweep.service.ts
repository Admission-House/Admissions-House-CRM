import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DatabaseService, Trx } from '../database/database.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';

export interface SweepResult {
  idleEnded: number;
  expiredEnded: number;
  notified: number;
}

/**
 * Signs out people who have gone quiet, and sessions that have reached their maximum age. Each
 * ended session checks its person out of attendance through the database trigger. When someone in
 * the office is signed out for inactivity, the Super Admins are told.
 *
 * The request guard already refuses an idle session the moment it is used; this sweep exists so
 * that a person who simply walked away is checked out on time, and so that someone is told.
 */
@Injectable()
export class IdleSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IdleSweepService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly db: DatabaseService,
    @Inject(ENV) private readonly env: Env,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    if (this.env.SWEEP_INTERVAL_SEC <= 0) return;
    this.timer = setInterval(() => void this.runSafely(), this.env.SWEEP_INTERVAL_SEC * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async runSafely(): Promise<void> {
    if (this.running) return; // the previous sweep is still going
    this.running = true;
    try {
      const total = await this.sweepOnce();
      if (total.idleEnded + total.expiredEnded > 0) {
        this.logger.log(`sweep ended ${total.idleEnded} idle and ${total.expiredEnded} expired sessions, ${total.notified} alerts`);
      }
    } catch (err) {
      this.logger.error(`sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
  }

  /** One pass over every active company. Safe to run on several servers at once. */
  async sweepOnce(): Promise<SweepResult> {
    const { rows } = await sql<{ id: string }>`SELECT list_active_tenant_ids() AS id`.execute(this.db.unscoped());
    const total: SweepResult = { idleEnded: 0, expiredEnded: 0, notified: 0 };
    for (const { id } of rows) {
      const result = await this.db.withTenant(id, (trx) => this.sweepTenant(trx, id));
      total.idleEnded += result.idleEnded;
      total.expiredEnded += result.expiredEnded;
      total.notified += result.notified;
    }
    return total;
  }

  private async sweepTenant(trx: Trx, tenantId: string): Promise<SweepResult> {
    // If another server holds the lock for this company, it is already doing the work.
    const { rows: lock } = await sql<{ ok: boolean }>`
      SELECT pg_try_advisory_xact_lock(hashtext('idle-sweep'), hashtext(${tenantId})) AS ok`.execute(trx);
    if (!lock[0]!.ok) return { idleEnded: 0, expiredEnded: 0, notified: 0 };

    const { rows: limits } = await sql<{ idle_min: number }>`
      SELECT COALESCE((SELECT a.idle_timeout_min FROM attendance_settings a, tenants t
                       WHERE a.effective_from <= (now() AT TIME ZONE t.timezone)::date
                       ORDER BY a.effective_from DESC LIMIT 1), 30) AS idle_min`.execute(trx);
    const idleMin = limits[0]!.idle_min;

    const { rows: idle } = await sql<{ user_id: string; last_active_at: Date }>`
      UPDATE user_sessions SET ended_at = now(), ended_reason = 'inactivity'
      WHERE ended_at IS NULL AND last_active_at < now() - make_interval(mins => ${idleMin})
      RETURNING user_id, last_active_at`.execute(trx);

    const { rows: expired } = await sql<{ id: string }>`
      UPDATE user_sessions SET ended_at = now(), ended_reason = 'expired'
      WHERE ended_at IS NULL AND expires_at <= now()
      RETURNING id`.execute(trx);

    let notified = 0;
    if (idle.length > 0) {
      // One alert per person who works from the office, however many sessions of theirs ended.
      const lastActive = new Map<string, Date>();
      for (const row of idle) {
        const seen = lastActive.get(row.user_id);
        if (!seen || row.last_active_at > seen) lastActive.set(row.user_id, row.last_active_at);
      }
      for (const [userId, at] of lastActive) {
        const { rowCount } = await this.notifySuperAdmins(trx, tenantId, userId, at, idleMin);
        notified += rowCount;
      }
    }
    return { idleEnded: idle.length, expiredEnded: expired.length, notified };
  }

  /** Tells every active Super Admin that a person in the office was signed out for inactivity. */
  private async notifySuperAdmins(trx: Trx, tenantId: string, userId: string, lastActiveAt: Date, idleMin: number) {
    const { rows } = await sql<{ name: string; office: boolean }>`
      SELECT u.name, r.requires_office AS office FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ${userId}`.execute(trx);
    // Only people who work from the office are reported; a Super Admin stepping away is not news.
    if (!rows[0]?.office) return { rowCount: 0 };

    const { rows: admins } = await sql<{ id: string }>`
      SELECT x.id FROM users x JOIN roles xr ON xr.id = x.role_id
      WHERE xr.system_key = 'super_admin' AND x.status = 'active'`.execute(trx);
    const rowCount = await this.notifications.notify(trx, {
      tenantId,
      userIds: admins.map((a) => a.id),
      type: 'security',
      payload: { event: 'idle_logout', userId, userName: rows[0].name, lastActiveAt: lastActiveAt.toISOString(), idleMinutes: idleMin },
    });
    return { rowCount };
  }
}
