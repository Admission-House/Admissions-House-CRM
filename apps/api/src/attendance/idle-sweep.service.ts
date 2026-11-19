import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { onBreakQuietMinutes } from '../auth/idle-rules.js';
import { sql } from 'kysely';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DatabaseService, Trx } from '../database/database.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { JobRegistry } from '../jobs/job-registry.service.js';

export interface SweepResult {
  /** Days closed because the shift ended. */
  shiftEndClosed?: number;
  idleEnded: number;
  expiredEnded: number;
  notified: number;
  /** People told that a break ran over its allowance, and people whose break reached the day's limit and were signed out. */
  breaksWarned?: number;
  breaksStopped?: number;
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
export class IdleSweepService implements OnModuleInit {
  private readonly logger = new Logger(IdleSweepService.name);
  private running = false;

  constructor(
    private readonly db: DatabaseService,
    @Inject(ENV) private readonly env: Env,
    private readonly notifications: NotificationsService,
  
    private readonly jobs: JobRegistry,
  ) {}

  onModuleInit(): void {
    this.jobs.register({ name: 'idle-sweep', group: 'minute', everySec: this.env.SWEEP_INTERVAL_SEC, run: () => this.runSafely() });
  }

  async runSafely(): Promise<void> {
    if (this.running) return; // the previous sweep is still going
    this.running = true;
    try {
      const total = await this.sweepOnce();
      if (total.idleEnded + total.expiredEnded + (total.shiftEndClosed ?? 0) > 0) {
        this.logger.log(`sweep ended ${total.idleEnded} idle and ${total.expiredEnded} expired sessions, closed ${total.shiftEndClosed ?? 0} days at shift end, ${total.notified} alerts`);
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
    const total: SweepResult = { idleEnded: 0, expiredEnded: 0, notified: 0, shiftEndClosed: 0, breaksWarned: 0, breaksStopped: 0 };
    for (const { id } of rows) {
      const result = await this.db.withTenant(id, (trx) => this.sweepTenant(trx, id));
      total.breaksWarned = (total.breaksWarned ?? 0) + (result.breaksWarned ?? 0);
      total.breaksStopped = (total.breaksStopped ?? 0) + (result.breaksStopped ?? 0);
      total.idleEnded += result.idleEnded;
      total.expiredEnded += result.expiredEnded;
      total.notified += result.notified;
      total.shiftEndClosed = (total.shiftEndClosed ?? 0) + (result.shiftEndClosed ?? 0);
    }
    return total;
  }

  private async sweepTenant(trx: Trx, tenantId: string): Promise<SweepResult> {
    // If another server holds the lock for this company, it is already doing the work.
    const { rows: lock } = await sql<{ ok: boolean }>`
      SELECT pg_try_advisory_xact_lock(hashtext('idle-sweep'), hashtext(${tenantId})) AS ok`.execute(trx);
    if (!lock[0]!.ok) return { idleEnded: 0, expiredEnded: 0, notified: 0, shiftEndClosed: 0 };

    const { rows: limits } = await sql<{ idle_min: number }>`
      SELECT COALESCE((SELECT a.idle_timeout_min FROM attendance_settings a, tenants t
                       WHERE a.effective_from <= (now() AT TIME ZONE t.timezone)::date
                       ORDER BY a.effective_from DESC LIMIT 1), 30) AS idle_min`.execute(trx);
    const idleMin = limits[0]!.idle_min;

    const { rows: idle } = await sql<{ user_id: string; last_active_at: Date }>`
      UPDATE user_sessions s SET ended_at = now(), ended_reason = 'inactivity'
      WHERE s.ended_at IS NULL AND s.last_active_at < now() - make_interval(mins => GREATEST(${idleMin}, COALESCE(${onBreakQuietMinutes}, 0)))
      RETURNING s.user_id, s.last_active_at`.execute(trx);

    const { rows: expired } = await sql<{ id: string }>`
      UPDATE user_sessions SET ended_at = now(), ended_reason = 'expired'
      WHERE ended_at IS NULL AND expires_at <= now()
      RETURNING id`.execute(trx);

    const shiftEndClosed = await this.closeDaysAtShiftEnd(trx);
    const breaks = await this.sweepBreaks(trx, tenantId);

    let notified = 0;
    if (idle.length > 0) {
      // One alert per person who works from the office, however many sessions of theirs ended.
      const lastActive = new Map<string, Date>();
      for (const row of idle) {
        const seen = lastActive.get(row.user_id);
        if (!seen || row.last_active_at > seen) lastActive.set(row.user_id, row.last_active_at);
      }
      for (const [userId, at] of lastActive) {
        const { rowCount } = await this.notifyIdleLogout(trx, tenantId, userId, at, idleMin);
        notified += rowCount;
      }
    }
    return { idleEnded: idle.length, expiredEnded: expired.length, notified, shiftEndClosed, breaksWarned: breaks.warned, breaksStopped: breaks.stopped };
  }

  /**
   * Breaks that are running right now. One that has gone past the allowance of its kind is told to the supervisors, once a
   * day, without waiting for it to end. One that has brought the day's break time to the hard limit is ended and its
   * person is signed out. The sign-out closes their attendance through the database trigger, like any other.
   */
  private async sweepBreaks(trx: Trx, tenantId: string): Promise<{ warned: number; stopped: number }> {
    const { rows } = await sql<{ attendance_id: string; user_id: string; user_name: string; break_id: string; break_name: string; allowed: number; kind_used: number; day_used: number; warned: boolean; hard: number }>`
      WITH limit_now AS (
        SELECT COALESCE((SELECT a.break_hard_limit_minutes FROM attendance_settings a, tenants t
                         WHERE a.effective_from <= (now() AT TIME ZONE t.timezone)::date ORDER BY a.effective_from DESC LIMIT 1), 100) AS hard)
      SELECT a.id AS attendance_id, a.user_id, u.name AS user_name, b.id AS break_id, bt.name AS break_name, bt.allowed_minutes AS allowed,
             (SELECT COALESCE(floor(sum(EXTRACT(EPOCH FROM COALESCE(x.ended_at, now()) - x.started_at)) / 60)::int, 0)
                FROM break_logs x WHERE x.attendance_id = a.id AND x.break_type_id = b.break_type_id) AS kind_used,
             (SELECT COALESCE(floor(sum(EXTRACT(EPOCH FROM COALESCE(x.ended_at, now()) - x.started_at)) / 60)::int, 0)
                FROM break_logs x WHERE x.attendance_id = a.id) AS day_used,
             (a.break_warned_at IS NOT NULL) AS warned, (SELECT hard FROM limit_now) AS hard
      FROM break_logs b
      JOIN attendance_records a ON a.id = b.attendance_id
      JOIN users u ON u.id = a.user_id
      JOIN roles ro ON ro.id = u.role_id
      JOIN break_types bt ON bt.id = b.break_type_id
      WHERE b.ended_at IS NULL AND ro.tracks_attendance`.execute(trx); // a role whose attendance is not recorded has no breaks to police

    let warned = 0;
    let stopped = 0;
    for (const r of rows) {
      if (r.day_used >= r.hard) {
        await sql`UPDATE break_logs SET ended_at = now() WHERE id = ${r.break_id} AND ended_at IS NULL`.execute(trx);
        await sql`UPDATE user_sessions SET ended_at = now(), ended_reason = 'revoked' WHERE user_id = ${r.user_id} AND ended_at IS NULL`.execute(trx);
        await this.notifications.notifyOversight(trx, {
          tenantId,
          payload: { event: 'break_limit_signout', userId: r.user_id, userName: r.user_name, usedMinutes: r.day_used, limitMinutes: r.hard },
        });
        stopped++;
      } else if (r.kind_used > r.allowed && !r.warned) {
        await sql`UPDATE attendance_records SET break_warned_at = now() WHERE id = ${r.attendance_id}`.execute(trx);
        await this.notifications.notifyOversight(trx, {
          tenantId,
          payload: { event: 'break_over', userId: r.user_id, userName: r.user_name, breakName: r.break_name, allowedMinutes: r.allowed, usedMinutes: r.kind_used },
        });
        warned++;
      }
    }
    return { warned, stopped };
  }

  /**
   * Checks out, at the moment the shift ended, everyone whose day is still open after it (requirement
   * ATT-6: check-out is recorded manually, at the end of the shift, or at a forced sign-out). The shift
   * is the one in force on that work date. A person who only checked in after the shift ended is left
   * alone; their day closes when their session does. Open breaks end at the same moment. The person's
   * session is not touched: they may keep working, but the day's attendance is closed.
   */
  private async closeDaysAtShiftEnd(trx: Trx): Promise<number> {
    const { rows } = await sql<{ id: string }>`
      WITH due AS (
        SELECT r.id, ((r.work_date + st.shift_end) AT TIME ZONE t.timezone) AS end_at
        FROM attendance_records r
        CROSS JOIN tenants t
        CROSS JOIN LATERAL (
          SELECT a.shift_end FROM attendance_settings a
          WHERE a.effective_from <= r.work_date ORDER BY a.effective_from DESC LIMIT 1
        ) st
        WHERE r.check_out_at IS NULL
      ),
      ended AS (
        SELECT id, end_at FROM due
        JOIN attendance_records r USING (id)
        WHERE due.end_at <= now() AND r.check_in_at < due.end_at
      ),
      closed_breaks AS (
        UPDATE break_logs b SET ended_at = GREATEST(e.end_at, b.started_at)
        FROM ended e WHERE b.attendance_id = e.id AND b.ended_at IS NULL
        RETURNING b.id
      )
      UPDATE attendance_records r SET check_out_at = e.end_at, check_out_reason = 'shift_end'
      FROM ended e WHERE r.id = e.id
      RETURNING r.id`.execute(trx);
    return rows.length;
  }

  /** Tells the Super Admins, and the Admin who manages the person, that someone in the office was signed out for inactivity. */
  private async notifyIdleLogout(trx: Trx, tenantId: string, userId: string, lastActiveAt: Date, idleMin: number) {
    const { rows } = await sql<{ name: string; office: boolean }>`
      SELECT u.name, r.requires_office AS office FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ${userId}`.execute(trx);
    // Only people who work from the office are reported; a Super Admin stepping away is not news.
    if (!rows[0]?.office) return { rowCount: 0 };
    const rowCount = await this.notifications.notifyOversight(trx, {
      tenantId,
      payload: { event: 'idle_logout', userId, userName: rows[0].name, lastActiveAt: lastActiveAt.toISOString(), idleMinutes: idleMin },
    });
    return { rowCount };
  }
}
