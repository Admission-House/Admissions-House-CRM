import { Injectable } from '@nestjs/common';
import { sql, SqlBool } from 'kysely';
import { z } from 'zod';
import { leadVisibility } from '../access/lead-scope.js';
import { scopeCondition } from '../access/scope.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppError } from '../common/app-error.js';
import { decodeCursor, Page, toPage } from '../common/pagination.js';
import { DatabaseService, Trx } from '../database/database.service.js';
import { FollowUpWriter } from '../leads/followup-writer.js';
import { assertFollowUpTime } from '../leads/lead-rules.js';
import { LeadAccess } from '../leads/lead-access.js';
import { LeadWriter } from '../leads/lead-writer.js';
import type { CreateFollowUpDto, ListFollowUpsDto, RescheduleDto } from './followups.dto.js';

export interface FollowUpView {
  id: string;
  dueAt: Date;
  remindBeforeMin: number;
  note: string | null;
  doneAt: Date | null;
  createdAt: Date;
  owner: { id: string; name: string };
  lead: { id: string; leadNo: string; name: string; phone: string; status: string; isOpen: boolean };
}

interface Row {
  id: string; lead_id: string; user_id: string; user_name: string; due_at: Date; remind_before_min: number; note: string | null;
  done_at: Date | null; created_at: Date; sort_text: string; lead_no: string; lead_name: string; primary_phone: string;
  status_name: string; is_open: boolean;
}

const cursorShape = z.object({ t: z.string(), i: z.string() });

const SELECT = sql`
  SELECT f.id, f.lead_id, f.user_id, u.name AS user_name, f.due_at, f.remind_before_min, f.note, f.done_at, f.created_at,
         l.lead_no::text AS lead_no, l.name AS lead_name, l.primary_phone, s.name AS status_name, s.is_open,
         (CASE WHEN f.done_at IS NULL THEN f.due_at ELSE f.done_at END)::text AS sort_text
  FROM followups f
  JOIN leads l ON l.id = f.lead_id AND l.deleted_at IS NULL
  JOIN lead_statuses s ON s.id = l.status_id
  JOIN users u ON u.id = f.user_id
  CROSS JOIN tenants t`;

@Injectable()
export class FollowUpsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly writer: FollowUpWriter,
    private readonly leadWriter: LeadWriter,
    private readonly access: LeadAccess,
  ) {}

  // -------------------------------------------------------------- one lead

  forLead(auth: AuthContext, leadId: string) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      await this.access.get(trx, auth, leadId, false);
      const { rows } = await sql<Row>`${SELECT} WHERE f.lead_id = ${leadId} ORDER BY f.done_at NULLS FIRST, f.due_at`.execute(trx);
      return rows.map(toView);
    });
  }

  create(auth: AuthContext, leadId: string, dto: CreateFollowUpDto) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const lead = await this.access.get(trx, auth, leadId, true);
      if (!lead.is_open) throw AppError.conflict('LEAD_CLOSED', 'This lead is closed, so it cannot have a follow-up');
      assertFollowUpTime(dto.dueAt);

      // The follow-up is the job of whoever owns the lead; for a lead nobody owns, of whoever sets it.
      const id = await this.writer.create(trx, {
        tenantId: auth.tenantId, leadId, userId: lead.assigned_to ?? auth.userId, dueAt: dto.dueAt,
        remindBeforeMin: dto.remindBeforeMin, note: dto.note,
      });
      await this.leadWriter.activity(trx, { tenantId: auth.tenantId, leadId, userId: auth.userId, type: 'followup', field: 'due_at', newValue: dto.dueAt.toISOString(), remark: dto.note ?? 'Follow-up set' });
      return this.one(trx, id);
    });
  }

  reschedule(auth: AuthContext, id: string, dto: RescheduleDto) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const f = await this.lockFollowUp(trx, auth, id);
      if (f.done_at) throw AppError.conflict('FOLLOWUP_CLOSED', 'This follow-up is already done');
      if (dto.dueAt) assertFollowUpTime(dto.dueAt);

      const movedTime = dto.dueAt !== undefined && dto.dueAt.getTime() !== f.due_at.getTime();
      const changes = {
        ...(dto.dueAt !== undefined && { due_at: dto.dueAt }),
        ...(dto.note !== undefined && { note: dto.note }),
        ...(dto.remindBeforeMin !== undefined && { remind_before_min: dto.remindBeforeMin }),
        // A new time earns a new reminder.
        ...((movedTime || dto.remindBeforeMin !== undefined) && { reminded_at: null }),
      };
      await trx.updateTable('followups').set(changes).where('id', '=', id).execute();
      await this.writer.refreshNext(trx, f.lead_id);
      if (movedTime) {
        await this.leadWriter.activity(trx, { tenantId: auth.tenantId, leadId: f.lead_id, userId: auth.userId, type: 'followup', field: 'due_at', oldValue: f.due_at.toISOString(), newValue: dto.dueAt!.toISOString(), remark: dto.note ?? 'Follow-up rescheduled' });
      }
      return this.one(trx, id);
    });
  }

  done(auth: AuthContext, id: string, note: string | undefined) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const f = await this.lockFollowUp(trx, auth, id);
      if (f.done_at) throw AppError.conflict('FOLLOWUP_CLOSED', 'This follow-up is already done');
      await sql`UPDATE followups SET done_at = now(), note = COALESCE(${note ?? null}, note) WHERE id = ${id}`.execute(trx);
      await this.writer.refreshNext(trx, f.lead_id);
      await this.leadWriter.activity(trx, { tenantId: auth.tenantId, leadId: f.lead_id, userId: auth.userId, type: 'followup', field: 'done', oldValue: f.due_at.toISOString(), remark: note ?? 'Follow-up done' });
      return this.one(trx, id);
    });
  }

  remove(auth: AuthContext, id: string): Promise<void> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const f = await this.lockFollowUp(trx, auth, id);
      await trx.deleteFrom('followups').where('id', '=', id).execute();
      await this.writer.refreshNext(trx, f.lead_id);
      await this.leadWriter.activity(trx, { tenantId: auth.tenantId, leadId: f.lead_id, userId: auth.userId, type: 'followup', field: 'cancelled', oldValue: f.due_at.toISOString(), remark: 'Follow-up cancelled' });
    });
  }

  // ------------------------------------------------------------------ lists

  /**
   * A person's follow-ups in one bucket. The buckets do not overlap: overdue is anything past due and
   * not done; today is what is still to come before midnight; upcoming is after today; done is finished.
   */
  list(auth: AuthContext, query: ListFollowUpsDto): Promise<Page<FollowUpView>> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const after = decodeCursor(query.cursor, cursorShape);
      const conditions = [this.scope(auth, query.userId), this.bucket(query.bucket)];
      const finished = query.bucket === 'done';
      if (after) {
        conditions.push(finished
          ? sql<SqlBool>`(f.done_at, f.id) < (${after.t}::timestamptz, ${after.i}::uuid)`
          : sql<SqlBool>`(f.due_at, f.id) > (${after.t}::timestamptz, ${after.i}::uuid)`);
      }
      const { rows } = await sql<Row>`
        ${SELECT}
        WHERE ${sql.join(conditions, sql` AND `)}
        ORDER BY ${finished ? sql`f.done_at DESC, f.id DESC` : sql`f.due_at ASC, f.id ASC`}
        LIMIT ${query.limit + 1}`.execute(trx);
      const page = toPage(rows, query.limit, (last) => ({ t: last.sort_text, i: last.id }));
      return { items: page.items.map(toView), nextCursor: page.nextCursor };
    });
  }

  /** How many are in each open bucket, for the badges. */
  summary(auth: AuthContext, userId?: string) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const { rows } = await sql<{ overdue: string; today: string; upcoming: string }>`
        SELECT count(*) FILTER (WHERE ${this.bucket('overdue')}) AS overdue,
               count(*) FILTER (WHERE ${this.bucket('today')}) AS today,
               count(*) FILTER (WHERE ${this.bucket('upcoming')}) AS upcoming
        FROM followups f
        JOIN leads l ON l.id = f.lead_id AND l.deleted_at IS NULL
        CROSS JOIN tenants t
        WHERE ${this.scope(auth, userId)}`.execute(trx);
      return { overdue: Number(rows[0]!.overdue), today: Number(rows[0]!.today), upcoming: Number(rows[0]!.upcoming) };
    });
  }

  // ---------------------------------------------------------------- helpers

  private scope(auth: AuthContext, userId: string | undefined) {
    const scoped = scopeCondition(auth, 'f.user_id');
    const parts = [scoped ?? sql<SqlBool>`true`];
    if (userId) parts.push(sql<SqlBool>`f.user_id = ${userId}::uuid`);
    return sql<SqlBool>`(${sql.join(parts, sql` AND `)})`;
  }

  private bucket(name: 'today' | 'overdue' | 'upcoming' | 'done') {
    switch (name) {
      case 'overdue':
        return sql<SqlBool>`(f.done_at IS NULL AND f.due_at < now())`;
      case 'today':
        return sql<SqlBool>`(f.done_at IS NULL AND f.due_at >= now() AND (f.due_at AT TIME ZONE t.timezone)::date = (now() AT TIME ZONE t.timezone)::date)`;
      case 'upcoming':
        return sql<SqlBool>`(f.done_at IS NULL AND (f.due_at AT TIME ZONE t.timezone)::date > (now() AT TIME ZONE t.timezone)::date)`;
      case 'done':
        return sql<SqlBool>`(f.done_at IS NOT NULL)`;
    }
  }

  private async one(trx: Trx, id: string): Promise<FollowUpView> {
    const { rows } = await sql<Row>`${SELECT} WHERE f.id = ${id}`.execute(trx);
    return toView(rows[0]!);
  }

  /** A follow-up on a lead the caller can see, locked while it changes. */
  private async lockFollowUp(trx: Trx, auth: AuthContext, id: string) {
    const visible = leadVisibility(auth);
    const { rows } = await sql<{ id: string; lead_id: string; due_at: Date; done_at: Date | null }>`
      SELECT f.id, f.lead_id, f.due_at, f.done_at
      FROM followups f JOIN leads l ON l.id = f.lead_id AND l.deleted_at IS NULL
      WHERE f.id = ${id} ${visible ? sql`AND ${visible}` : sql``}
      FOR UPDATE OF f`.execute(trx);
    if (!rows[0]) throw AppError.notFound('Follow-up');
    return rows[0];
  }
}

function toView(r: Row): FollowUpView {
  return {
    id: r.id, dueAt: r.due_at, remindBeforeMin: r.remind_before_min, note: r.note, doneAt: r.done_at, createdAt: r.created_at,
    owner: { id: r.user_id, name: r.user_name },
    lead: { id: r.lead_id, leadNo: r.lead_no, name: r.lead_name, phone: r.primary_phone, status: r.status_name, isOpen: r.is_open },
  };
}
