import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { PushMessage, PushProvider, PushTransportError } from './push-provider.js';
import { pushText } from './push-text.js';

/** A notification older than this when the job gets to it (the server was down) is not worth an alert any more. */
const FRESH_MINUTES = 15;
/** Notifications taken per company per pass. The rest are taken on the next pass. */
const BATCH = 200;

interface Claimed { id: string; user_id: string; payload: Record<string, unknown>; stale: boolean }

export interface DispatchSummary { claimed: number; alerts: number; sent: number; dropped: number; retried: number; stale: number }

/**
 * Sends new notifications to people's phones. It takes notifications that have not been sent
 * (marking them in the same statement, so two servers never send the same one), then sends them
 * with no database transaction open, because that waits on another company's server. If the
 * delivery service is down the notifications are released and tried again on the next pass, until
 * they are too old to be worth an alert. A phone that reports it is gone is forgotten.
 */
@Injectable()
export class PushDispatchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PushDispatchService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly provider: PushProvider,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    if (this.env.PUSH_INTERVAL_SEC <= 0 || this.env.PUSH_PROVIDER === 'off') return;
    this.timer = setInterval(() => void this.runSafely(), this.env.PUSH_INTERVAL_SEC * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async runSafely(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const s = await this.runOnce();
      if (s.sent > 0 || s.retried > 0) this.logger.log(`alerts: ${s.sent} sent, ${s.dropped} phones forgotten, ${s.retried} to retry`);
    } catch (err) {
      this.logger.error(`phone alerts failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
  }

  /** One pass over every active company. */
  async runOnce(provider: PushProvider = this.provider): Promise<DispatchSummary> {
    const total: DispatchSummary = { claimed: 0, alerts: 0, sent: 0, dropped: 0, retried: 0, stale: 0 };
    const { rows: tenants } = await sql<{ id: string }>`SELECT list_active_tenant_ids() AS id`.execute(this.db.unscoped());
    for (const { id: tenantId } of tenants) {
      const s = await this.runTenant(tenantId, provider);
      for (const k of Object.keys(total) as (keyof DispatchSummary)[]) total[k] += s[k];
    }
    return total;
  }

  private async runTenant(tenantId: string, provider: PushProvider): Promise<DispatchSummary> {
    const summary: DispatchSummary = { claimed: 0, alerts: 0, sent: 0, dropped: 0, retried: 0, stale: 0 };

    // 1. Take the unsent notifications and find the phones to send them to.
    const { claimed, phones } = await this.db.withTenant(tenantId, async (trx) => {
      const { rows } = await sql<Claimed>`
        UPDATE notifications n SET pushed_at = now()
        WHERE (n.id, n.created_at) IN (
          SELECT id, created_at FROM notifications WHERE pushed_at IS NULL ORDER BY created_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
        RETURNING n.id::text AS id, n.user_id, n.payload, (n.created_at < now() - make_interval(mins => ${FRESH_MINUTES})) AS stale`.execute(trx);
      const byUser = new Map<string, string[]>();
      const userIds = [...new Set(rows.filter((r) => !r.stale).map((r) => r.user_id))];
      if (userIds.length > 0) {
        const { rows: tokens } = await sql<{ user_id: string; token: string }>`
          SELECT t.user_id, t.token FROM push_tokens t
          JOIN user_sessions s ON s.id = t.session_id AND s.ended_at IS NULL AND s.expires_at > now()
          JOIN users u ON u.id = t.user_id AND u.status = 'active'
          WHERE t.user_id = ANY(${userIds}::uuid[])`.execute(trx);
        for (const t of tokens) byUser.set(t.user_id, [...(byUser.get(t.user_id) ?? []), t.token]);
      }
      return { claimed: rows, phones: byUser };
    });
    summary.claimed = claimed.length;
    if (claimed.length === 0) return summary;

    // 2. Work out the alerts. Stale ones, ones that are not alert-worthy and people with no phone need nothing more.
    const messages: (PushMessage & { notificationId: string })[] = [];
    for (const n of claimed) {
      if (n.stale) {
        summary.stale += 1;
        continue;
      }
      const text = pushText(n.payload);
      const tokens = phones.get(n.user_id);
      if (!text || !tokens) continue;
      const data: Record<string, string> = { notificationId: n.id, ...(text.data.leadId && { leadId: text.data.leadId }), ...(text.data.screen && { screen: text.data.screen }) };
      for (const to of tokens) messages.push({ to, title: text.title, ...(text.body && { body: text.body }), data, notificationId: n.id });
    }
    summary.alerts = messages.length;
    if (messages.length === 0) return summary;

    // 3. Send, with no transaction open.
    let results;
    try {
      results = await provider.send(messages.map(({ notificationId: _id, ...m }) => m));
    } catch (e) {
      if (e instanceof PushTransportError && e.retryable) {
        const ids = [...new Set(messages.map((m) => m.notificationId))];
        await this.release(tenantId, ids);
        summary.retried = ids.length;
        this.logger.warn(`${e.message}; will try again`);
        return summary;
      }
      this.logger.error(`alerts were refused: ${e instanceof Error ? e.message : String(e)}`);
      return summary;
    }

    // 4. Forget phones that said they are gone.
    const dead = new Set<string>();
    results.forEach((r, i) => {
      if (r.status === 'ok') summary.sent += 1;
      else if (r.dead) dead.add(messages[i]!.to);
    });
    if (dead.size > 0) {
      await this.db.withTenant(tenantId, (trx) => sql`DELETE FROM push_tokens WHERE token = ANY(${[...dead]}::text[])`.execute(trx));
      summary.dropped = dead.size;
    }
    return summary;
  }

  /** Puts notifications back as unsent, so the next pass tries them again. */
  private release(tenantId: string, ids: string[]): Promise<unknown> {
    return this.db.withTenant(tenantId, (trx) => sql`
      UPDATE notifications SET pushed_at = NULL
      WHERE id = ANY(${ids}::bigint[]) AND created_at > now() - make_interval(mins => ${FRESH_MINUTES})`.execute(trx));
  }
}
