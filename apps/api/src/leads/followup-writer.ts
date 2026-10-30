import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Trx } from '../database/database.service.js';

/**
 * Follow-ups, and the one deliberate copy in the lead table: leads.next_followup_at, the earliest
 * open follow-up, which makes the queues and "due today" lists fast. Every change to a follow-up
 * goes through here so the copy is always updated in the same transaction.
 */
@Injectable()
export class FollowUpWriter {
  async create(
    trx: Trx,
    f: { tenantId: string; leadId: string; userId: string; dueAt: Date; remindBeforeMin?: number; note?: string | null },
  ): Promise<string> {
    const row = await trx
      .insertInto('followups')
      .values({
        tenant_id: f.tenantId,
        lead_id: f.leadId,
        user_id: f.userId,
        due_at: f.dueAt,
        remind_before_min: f.remindBeforeMin ?? 10,
        note: f.note ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.refreshNext(trx, f.leadId);
    return row.id;
  }

  /** Sets the lead's next follow-up to the earliest one still open, or none. */
  async refreshNext(trx: Trx, leadId: string): Promise<void> {
    await sql`
      UPDATE leads SET next_followup_at = (
        SELECT min(due_at) FROM followups WHERE lead_id = ${leadId} AND done_at IS NULL)
      WHERE id = ${leadId}`.execute(trx);
  }

  /** Finishes every open follow-up of the lead, for example when the lead is closed. */
  async closeAll(trx: Trx, leadId: string): Promise<number> {
    const result = await sql`UPDATE followups SET done_at = now() WHERE lead_id = ${leadId} AND done_at IS NULL`.execute(trx);
    await this.refreshNext(trx, leadId);
    return Number(result.numAffectedRows ?? 0);
  }

  /** Whether the lead has an open follow-up that has not yet come due. */
  async hasUpcoming(trx: Trx, leadId: string): Promise<boolean> {
    const { rows } = await sql<{ n: string }>`
      SELECT count(*) AS n FROM followups WHERE lead_id = ${leadId} AND done_at IS NULL AND due_at > now()`.execute(trx);
    return Number(rows[0]!.n) > 0;
  }
}
