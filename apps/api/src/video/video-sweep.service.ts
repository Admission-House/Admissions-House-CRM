import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { EMPTY_CALL_GRACE_SECONDS, PRESENCE_STALE_SECONDS, REMINDER_MINUTES } from './video-rules.js';
import { SessionRow, VideoStore } from './video-store.js';

export interface SweepCounts {
  missed: number;
  lost: number;
  endedEmpty: number;
  endedTimeUp: number;
  cancelled: number;
  reminders: number;
}

/**
 * Looks after what nobody is watching: a ring nobody answered, a screen that disappeared, a call everyone
 * has left, a meeting whose time is up, and the reminder before a planned meeting. It runs on every server;
 * an advisory lock per company means one of them does the work.
 */
@Injectable()
export class VideoSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VideoSweepService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly store: VideoStore,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    if (this.env.COMMUNICATION_SWEEP_SEC <= 0) return;
    this.timer = setInterval(() => void this.runSafely(), this.env.COMMUNICATION_SWEEP_SEC * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass over every active company. */
  async runOnce(): Promise<SweepCounts> {
    const total: SweepCounts = { missed: 0, lost: 0, endedEmpty: 0, endedTimeUp: 0, cancelled: 0, reminders: 0 };
    const { rows: tenants } = await sql<{ id: string }>`SELECT list_active_tenant_ids() AS id`.execute(this.db.unscoped());
    for (const { id } of tenants) {
      const c = await this.sweepTenant(id);
      for (const k of Object.keys(total) as (keyof SweepCounts)[]) total[k] += c[k];
    }
    return total;
  }

  private sweepTenant(tenantId: string): Promise<SweepCounts> {
    return this.db.withTenant(tenantId, async (trx) => {
      const counts: SweepCounts = { missed: 0, lost: 0, endedEmpty: 0, endedTimeUp: 0, cancelled: 0, reminders: 0 };
      const { rows: lock } = await sql<{ ok: boolean }>`SELECT pg_try_advisory_xact_lock(hashtext('communication-sweep'), hashtext(${tenantId})) AS ok`.execute(trx);
      if (!lock[0]?.ok) return counts;

      // 1. A ring nobody answered is a missed call; the person called is told, and a call nobody joined ends as missed.
      const { rows: missed } = await sql<{ id: string; session_id: string; user_id: string }>`
        UPDATE video_session_invites SET state = 'missed', responded_at = now()
        WHERE state = 'ringing' AND invited_at < now() - make_interval(secs => ${this.env.COMMUNICATION_RING_SECONDS})
        RETURNING id, session_id, user_id`.execute(trx);
      for (const m of missed) {
        counts.missed++;
        await this.store.event(trx, tenantId, m.session_id, m.id, 'missed');
        const session = await this.store.load(trx, m.session_id, { lock: true });
        await this.store.notify(trx, tenantId, [m.user_id], 'comm_missed', { sessionId: session.id, kind: session.kind, fromName: session.creator_name, leadId: session.lead_id ?? undefined, leadName: session.lead_name ?? undefined });
        if (session.type === 'call' && session.status === 'open') await this.store.end(trx, session, 'missed', { detail: 'not answered' });
      }

      // 2. A screen that has stopped reporting has left (closed the tab, lost the network).
      const { rows: lost } = await sql<{ id: string; session_id: string }>`
        UPDATE video_session_invites SET joined_at = NULL, last_left_at = last_seen_at
        WHERE joined_at IS NOT NULL AND last_seen_at < now() - make_interval(secs => ${PRESENCE_STALE_SECONDS})
        RETURNING id, session_id`.execute(trx);
      for (const l of lost) {
        counts.lost++;
        await this.store.event(trx, tenantId, l.session_id, l.id, 'left', 'connection lost');
      }

      // 3. A call (not a meeting) that has been empty for a while is over.
      const { rows: empty } = await sql<{ id: string }>`
        SELECT v.id FROM video_sessions v
        WHERE v.status = 'open' AND v.type = 'call' AND v.started_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM video_session_invites i WHERE i.session_id = v.id AND i.joined_at IS NOT NULL)
          AND COALESCE((SELECT max(i.last_left_at) FROM video_session_invites i WHERE i.session_id = v.id), v.started_at) < now() - make_interval(secs => ${EMPTY_CALL_GRACE_SECONDS})
          AND v.started_at < now() - make_interval(secs => ${EMPTY_CALL_GRACE_SECONDS})`.execute(trx);
      for (const e of empty) {
        await this.store.end(trx, await this.store.load(trx, e.id, { lock: true }), 'completed', { detail: 'everyone left' });
        counts.endedEmpty++;
      }

      // 4. Sessions whose agreed time has run out.
      const { rows: late } = await sql<{ id: string }>`
        SELECT id FROM video_sessions WHERE status = 'open' AND started_at IS NOT NULL AND started_at + max_minutes * interval '1 minute' < now()`.execute(trx);
      for (const s of late) {
        await this.store.end(trx, await this.store.load(trx, s.id, { lock: true }), 'completed', { detail: 'time was up' });
        counts.endedTimeUp++;
      }

      // 5. Sessions nobody ever joined, long after they were meant to happen.
      const { rows: stale } = await sql<{ id: string }>`
        SELECT id FROM video_sessions
        WHERE status = 'open' AND started_at IS NULL AND COALESCE(scheduled_for, created_at) + max_minutes * interval '1 minute' + interval '1 hour' < now()`.execute(trx);
      for (const s of stale) {
        await this.store.end(trx, await this.store.load(trx, s.id, { lock: true }), 'cancelled', { detail: 'nobody joined' });
        counts.cancelled++;
      }

      // 6. A planned meeting reminds the staff who are invited, once.
      const { rows: soon } = await sql<{ id: string }>`
        SELECT id FROM video_sessions
        WHERE status = 'open' AND type = 'meeting' AND started_at IS NULL AND reminded_at IS NULL
          AND scheduled_for IS NOT NULL AND scheduled_for <= now() + make_interval(mins => ${REMINDER_MINUTES}) AND scheduled_for > now() - interval '5 minutes'`.execute(trx);
      for (const s of soon) {
        const session: SessionRow = await this.store.load(trx, s.id, { lock: true });
        await sql`UPDATE video_sessions SET reminded_at = now() WHERE id = ${s.id}::uuid`.execute(trx);
        const people = (await this.store.invites(trx, s.id)).filter((i) => i.user_id && ['invited', 'accepted'].includes(i.state));
        await this.store.notify(trx, tenantId, people.map((i) => i.user_id!), 'comm_meeting_reminder', {
          sessionId: s.id, title: session.title ?? undefined, kind: session.kind, fromName: session.creator_name, scheduledFor: session.scheduled_for?.toISOString(),
        });
        await this.store.event(trx, tenantId, s.id, null, 'reminder');
        counts.reminders++;
      }
      return counts;
    });
  }

  private async runSafely(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const c = await this.runOnce();
      if (c.missed + c.endedEmpty + c.endedTimeUp + c.cancelled + c.reminders > 0) {
        this.logger.log(`calls: ${c.missed} missed, ${c.endedEmpty} ended empty, ${c.endedTimeUp} ended at time, ${c.cancelled} cancelled, ${c.reminders} reminders`);
      }
    } catch (err) {
      this.logger.error(`communication sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
  }
}
