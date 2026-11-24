import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { JobRegistry } from '../jobs/job-registry.service.js';

/**
 * Tells people their follow-ups are coming up. A follow-up is reminded once, a set number of minutes
 * before it is due (each has its own), and again only if it is moved to a new time. Marking a
 * follow-up as reminded and writing the notification happen in one transaction, so a crash cannot
 * lose a reminder or send it twice.
 */
@Injectable()
export class FollowUpReminderService implements OnModuleInit {
  private readonly logger = new Logger(FollowUpReminderService.name);
  private running = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly notifications: NotificationsService,
    @Inject(ENV) private readonly env: Env,
  
    private readonly jobs: JobRegistry,
  ) {}

  onModuleInit(): void {
    this.jobs.register({ name: 'followup-reminder', group: 'minute', everySec: this.env.FOLLOWUP_REMINDER_INTERVAL_SEC, run: () => this.runSafely() });
  }

  async runSafely(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const sent = await this.runOnce();
      if (sent > 0) this.logger.log(`sent ${sent} follow-up reminders`);
    } catch (err) {
      this.logger.error(`follow-up reminders failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
  }

  /** One pass over every active company. Returns how many reminders were sent. */
  async runOnce(): Promise<number> {
    const { rows: tenants } = await sql<{ id: string }>`SELECT list_active_tenant_ids() AS id`.execute(this.db.unscoped());
    let sent = 0;
    for (const { id: tenantId } of tenants) {
      sent += await this.db.withTenant(tenantId, async (trx) => {
        const { rows: lock } = await sql<{ ok: boolean }>`SELECT pg_try_advisory_xact_lock(hashtext('followup-reminders'), hashtext(${tenantId})) AS ok`.execute(trx);
        if (!lock[0]!.ok) return 0;

        const { rows } = await sql<{ id: string; user_id: string; lead_id: string; due_at: Date; note: string | null; lead_no: string; lead_name: string }>`
          UPDATE followups f SET reminded_at = now()
          FROM leads l
          WHERE l.id = f.lead_id AND l.deleted_at IS NULL
            AND f.done_at IS NULL AND f.reminded_at IS NULL
            AND f.due_at - make_interval(mins => f.remind_before_min) <= now()
          RETURNING f.id, f.user_id, f.lead_id, f.due_at, f.note, l.lead_no::text AS lead_no, l.name AS lead_name`.execute(trx);
        for (const r of rows) {
          await this.notifications.notify(trx, {
            tenantId, userIds: [r.user_id], type: 'followup_due',
            payload: { event: 'followup_due', followUpId: r.id, leadId: r.lead_id, leadNo: r.lead_no, name: r.lead_name, dueAt: r.due_at.toISOString(), note: r.note },
          });
        }
        return rows.length;
      });
    }
    return sent;
  }
}
