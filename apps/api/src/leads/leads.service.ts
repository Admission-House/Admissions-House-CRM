import { Injectable } from '@nestjs/common';
import { sql, SqlBool } from 'kysely';
import { z } from 'zod';
import { leadVisibility } from '../access/lead-scope.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppError } from '../common/app-error.js';
import { decodeCursor, Page, toPage } from '../common/pagination.js';
import { DatabaseService, Trx } from '../database/database.service.js';
import { AssignmentService } from '../intake/assignment.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { AuditService } from '../audit/audit.service.js';
import { Assignees } from './assignees.js';
import { ExportRow, MAX_EXPORT_ROWS, toCsv, toXlsx } from './lead-export.js';
import { FollowUpWriter } from './followup-writer.js';
import { LeadWriter } from './lead-writer.js';
import {
  assertFollowUpForStatus,
  assertFollowUpTime,
  classifySearch,
  diffFields,
  likePattern,
} from './lead-rules.js';
import type {
  AssignDto,
  BulkAssignDto,
  BulkStatusDto,
  ChangeStatusDto,
  CreateLeadDto,
  ExportLeadsDto,
  ListLeadsDto,
  UpdateLeadDto,
} from './leads.dto.js';

/**
 * The queue a lead is shown in. A lead that is still open and whose follow-up time has passed
 * belongs in Missed, whatever its status says; otherwise it sits in the queue of its status. Each
 * lead is in exactly one queue, so the counts add up.
 */
const EFFECTIVE_QUEUE = sql`CASE WHEN s.is_open AND l.next_followup_at < now() THEN 'missed' ELSE s.queue END`;

const FROM_LEADS = sql`
  FROM leads l
  JOIN lead_statuses s ON s.id = l.status_id
  JOIN lead_sources src ON src.id = l.source_id
  LEFT JOIN users a ON a.id = l.assigned_to
  CROSS JOIN tenants t`;

export interface LeadListItem {
  id: string;
  leadNo: string;
  name: string;
  phone: string;
  email: string | null;
  intent: string | null;
  studyMode: string | null;
  status: { id: string; name: string; queue: string; isOpen: boolean };
  queue: string;
  source: { id: string; name: string };
  assignedTo: { id: string; name: string } | null;
  nextFollowupAt: Date | null;
  expectedClosureOn: string | null;
  interestNote: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ListRow {
  id: string;
  lead_no: string;
  name: string;
  primary_phone: string;
  email: string | null;
  intent: string | null;
  study_mode: string | null;
  next_followup_at: Date | null;
  expected_closure_on: string | null;
  interest_note: string | null;
  created_at: Date;
  updated_at: Date;
  assigned_to: string | null;
  assignee_name: string | null;
  status_id: string;
  status_name: string;
  status_queue: string;
  status_open: boolean;
  queue: string;
  source_id: string;
  source_name: string;
  sort_key: string;
}

/** The lead row as the write paths see it, locked until the transaction ends. */
interface LockedLead {
  id: string;
  lead_no: string;
  name: string;
  primary_phone: string;
  email: string | null;
  intent: string | null;
  study_mode: string | null;
  expected_closure_on: string | null;
  interested_course_id: string | null;
  interested_location_id: string | null;
  interest_note: string | null;
  status_id: string;
  substatus_id: string | null;
  assigned_to: string | null;
  assignee_name: string | null;
}

const cursorShape = z.object({ t: z.string(), i: z.string() });
const activityCursor = z.object({ t: z.string(), i: z.string() });

@Injectable()
export class LeadsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly writer: LeadWriter,
    private readonly followUps: FollowUpWriter,
    private readonly assignment: AssignmentService,
    private readonly notifications: NotificationsService,
    private readonly assignees: Assignees,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------- list

  list(auth: AuthContext, query: ListLeadsDto): Promise<Page<LeadListItem>> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const after = decodeCursor(query.cursor, cursorShape);
      const conditions = this.filters(auth, query);

      // Each ordering names the column the cursor remembers, so the next page starts just after it.
      const order = {
        newest: { key: sql`l.created_at`, dir: sql`DESC`, op: sql`<`, tie: sql`DESC` },
        updated: { key: sql`l.updated_at`, dir: sql`DESC`, op: sql`<`, tie: sql`DESC` },
        followup: {
          key: sql`COALESCE(l.next_followup_at, 'infinity'::timestamptz)`,
          dir: sql`ASC`,
          op: sql`>`,
          tie: sql`ASC`,
        },
      }[query.sort];
      if (after)
        conditions.push(
          sql<SqlBool>`(${order.key}, l.id) ${order.op} (${after.t}::timestamptz, ${after.i}::uuid)`,
        );

      const { rows } = await sql<ListRow>`
        SELECT l.id, l.lead_no::text AS lead_no, l.name, l.primary_phone, l.email, l.intent, l.study_mode,
               l.next_followup_at, l.expected_closure_on::text AS expected_closure_on, l.interest_note,
               l.created_at, l.updated_at, l.assigned_to, a.name AS assignee_name,
               s.id AS status_id, s.name AS status_name, s.queue AS status_queue, s.is_open AS status_open,
               ${EFFECTIVE_QUEUE} AS queue, src.id AS source_id, src.name AS source_name,
               (${order.key})::text AS sort_key
        ${FROM_LEADS}
        WHERE ${sql.join(conditions, sql` AND `)}
        ORDER BY ${order.key} ${order.dir}, l.id ${order.tie}
        LIMIT ${query.limit + 1}`.execute(trx);

      const page = toPage(rows, query.limit, (last) => ({ t: last.sort_key, i: last.id }));
      return { items: page.items.map(toListItem), nextCursor: page.nextCursor };
    });
  }

  /** Every lead that matches the filters, as a file. Refused when it would be too large to open comfortably. */
  exportFile(
    auth: AuthContext,
    query: ExportLeadsDto,
  ): Promise<{ fileName: string; contentType: string; body: string | Buffer }> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const filters = this.filters(auth, { ...query, limit: 1, sort: 'newest' } as ListLeadsDto);
      const { rows } = await sql<ExportRow>`
        SELECT l.lead_no::text AS lead_no, l.name, l.primary_phone AS phone, l.email, s.name AS status, ${EFFECTIVE_QUEUE} AS queue, src.name AS source,
               a.name AS assigned_to, l.intent, l.study_mode, l.interest_note AS interest,
               to_char(l.next_followup_at AT TIME ZONE t.timezone, 'YYYY-MM-DD HH24:MI') AS next_followup,
               l.expected_closure_on::text AS expected_closure,
               to_char(l.created_at AT TIME ZONE t.timezone, 'YYYY-MM-DD HH24:MI') AS created,
               to_char(l.updated_at AT TIME ZONE t.timezone, 'YYYY-MM-DD HH24:MI') AS updated
        ${FROM_LEADS}
        WHERE ${sql.join(filters, sql` AND `)}
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT ${MAX_EXPORT_ROWS + 1}`.execute(trx);
      if (rows.length > MAX_EXPORT_ROWS) {
        throw new AppError(
          'EXPORT_TOO_LARGE',
          `More than ${MAX_EXPORT_ROWS.toLocaleString('en-IN')} leads match. Narrow the filters (for example a date range) and export in parts.`,
          422,
        );
      }
      await this.audit.write(trx, {
        tenantId: auth.tenantId,
        actorId: auth.userId,
        action: 'lead.export',
        entity: 'lead',
        after: {
          count: rows.length,
          format: query.format,
          filters: { ...query, format: undefined },
        },
        ip: auth.ip,
        requestId: auth.requestId,
      });
      const stamp = new Date().toISOString().slice(0, 10);
      return query.format === 'xlsx'
        ? {
            fileName: `leads-${stamp}.xlsx`,
            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            body: await toXlsx(rows),
          }
        : {
            fileName: `leads-${stamp}.csv`,
            contentType: 'text/csv; charset=utf-8',
            body: toCsv(rows),
          };
    });
  }

  /** How many leads are in each queue, for the tabs of the lead screen. */
  async queues(auth: AuthContext) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const visible = leadVisibility(auth);
      const { rows } = await sql<{
        queue: string;
        n: string;
        unassigned: string;
        due_today: string;
      }>`
        SELECT ${EFFECTIVE_QUEUE} AS queue, count(*) AS n,
               count(*) FILTER (WHERE l.assigned_to IS NULL) AS unassigned,
               count(*) FILTER (WHERE s.is_open AND l.next_followup_at >= now()
                                  AND (l.next_followup_at AT TIME ZONE t.timezone)::date = (now() AT TIME ZONE t.timezone)::date) AS due_today
        ${FROM_LEADS}
        WHERE l.deleted_at IS NULL ${visible ? sql`AND ${visible}` : sql``}
        GROUP BY 1`.execute(trx);

      const counts: Record<string, number> = {
        fresh: 0,
        missed: 0,
        followup: 0,
        counselled: 0,
        fee_paid: 0,
        closed: 0,
      };
      let unassigned = 0;
      let dueToday = 0;
      for (const r of rows) {
        counts[r.queue] = Number(r.n);
        unassigned += Number(r.unassigned);
        dueToday += Number(r.due_today);
      }
      return {
        queues: counts,
        unassigned,
        dueToday,
        total: Object.values(counts).reduce((a, b) => a + b, 0),
      };
    });
  }

  // ----------------------------------------------------------------- detail

  get(auth: AuthContext, id: string) {
    return this.db.withTenant(auth.tenantId, (trx) => this.detail(trx, auth, id));
  }

  activities(auth: AuthContext, id: string, query: { limit: number; cursor?: string }) {
    return this.db.withTenant(auth.tenantId, async (trx): Promise<Page<ActivityView>> => {
      await this.requireVisible(trx, auth, id);
      const after = decodeCursor(query.cursor, activityCursor);
      const conditions = [sql<SqlBool>`a.lead_id = ${id}::uuid`];
      if (after)
        conditions.push(
          sql<SqlBool>`(a.created_at, a.id) < (${after.t}::timestamptz, ${after.i}::bigint)`,
        );

      const { rows } = await sql<{
        id: string;
        type: string;
        field: string | null;
        old_value: string | null;
        new_value: string | null;
        remark: string | null;
        created_at: Date;
        created_text: string;
        user_id: string | null;
        user_name: string | null;
      }>`
        SELECT a.id::text AS id, a.type, a.field, a.old_value, a.new_value, a.remark, a.created_at,
               a.created_at::text AS created_text, a.user_id, u.name AS user_name
        FROM lead_activities a LEFT JOIN users u ON u.id = a.user_id
        WHERE ${sql.join(conditions, sql` AND `)}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ${query.limit + 1}`.execute(trx);
      const page = toPage(rows, query.limit, (last) => ({ t: last.created_text, i: last.id }));
      return {
        items: page.items.map((r) => ({
          id: r.id,
          type: r.type,
          field: r.field,
          oldValue: r.old_value,
          newValue: r.new_value,
          remark: r.remark,
          user: r.user_id ? { id: r.user_id, name: r.user_name ?? '' } : null,
          createdAt: r.created_at,
        })),
        nextCursor: page.nextCursor,
      };
    });
  }

  // ----------------------------------------------------------------- create

  create(auth: AuthContext, dto: CreateLeadDto) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      if (dto.followUp && !auth.permissions.has('followup.manage')) throw AppError.forbidden();
      if (dto.followUp) assertFollowUpTime(dto.followUp.dueAt);

      const source = await trx
        .selectFrom('lead_sources')
        .select(['id', 'name', 'is_active'])
        .where('id', '=', dto.sourceId)
        .executeTakeFirst();
      if (!source || !source.is_active)
        throw invalid('SOURCE_INVALID', 'sourceId', 'Choose a lead source that is in use');
      await this.assertExists(trx, 'courses', dto.interestedCourseId, 'interestedCourseId');
      await this.assertExists(trx, 'locations', dto.interestedLocationId, 'interestedLocationId');

      const duplicate = await this.findByPhone(trx, dto.phone);
      if (duplicate) throw duplicateError(duplicate);

      const assignedTo = await this.chooseAssignee(trx, auth, dto, source.id);
      const created = await this.writer.insertLead(trx, {
        tenantId: auth.tenantId,
        name: dto.name,
        email: dto.email,
        phone: dto.phone,
        statusId: await this.writer.freshStatusId(trx),
        sourceId: source.id,
        studyMode: dto.studyMode,
        intent: dto.intent,
        expectedClosureOn: dto.expectedClosureOn,
        assignedTo,
        interestedCourseId: dto.interestedCourseId,
        interestedLocationId: dto.interestedLocationId,
        createdBy: auth.userId,
      });
      if (!created) throw duplicateError((await this.findByPhone(trx, dto.phone))!);

      await this.writer.activity(trx, {
        tenantId: auth.tenantId,
        leadId: created.id,
        userId: auth.userId,
        type: 'enquiry',
        remark: `Added by ${auth.name} (${source.name})`,
      });
      if (assignedTo)
        await this.recordAssignment(
          trx,
          auth,
          created.id,
          created.leadNo,
          null,
          assignedTo,
          'Assigned when the lead was added',
        );
      if (dto.note)
        await this.writer.activity(trx, {
          tenantId: auth.tenantId,
          leadId: created.id,
          userId: auth.userId,
          type: 'note',
          remark: dto.note,
        });
      if (dto.followUp) {
        await this.followUps.create(trx, {
          tenantId: auth.tenantId,
          leadId: created.id,
          userId: assignedTo ?? auth.userId,
          dueAt: dto.followUp.dueAt,
          note: dto.followUp.note,
          remindBeforeMin: dto.followUp.remindBeforeMin,
        });
        await this.writer.activity(trx, {
          tenantId: auth.tenantId,
          leadId: created.id,
          userId: auth.userId,
          type: 'followup',
          newValue: dto.followUp.dueAt.toISOString(),
          remark: dto.followUp.note ?? 'Follow-up set',
        });
      }
      return this.detail(trx, auth, created.id);
    });
  }

  // ------------------------------------------------------------------- edit

  update(auth: AuthContext, id: string, dto: UpdateLeadDto) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const lead = await this.lockVisible(trx, auth, id);
      if (dto.phone && dto.phone !== lead.primary_phone) {
        const taken = await this.findByPhone(trx, dto.phone);
        if (taken && taken.id !== id) throw duplicateError(taken);
      }
      await this.assertExists(trx, 'courses', dto.interestedCourseId, 'interestedCourseId');
      await this.assertExists(trx, 'locations', dto.interestedLocationId, 'interestedLocationId');

      // The columns to change, keyed by their database names, and the same facts under the API's names for the history.
      const next: Record<string, unknown> = {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.phone !== undefined && { phone: dto.phone }),
        ...(dto.email !== undefined && { email: dto.email }),
        ...(dto.intent !== undefined && { intent: dto.intent }),
        ...(dto.studyMode !== undefined && { study_mode: dto.studyMode }),
        ...(dto.expectedClosureOn !== undefined && { expected_closure_on: dto.expectedClosureOn }),
        ...(dto.interestedCourseId !== undefined && {
          interested_course_id: dto.interestedCourseId,
        }),
        ...(dto.interestedLocationId !== undefined && {
          interested_location_id: dto.interestedLocationId,
        }),
        ...(dto.interestNote !== undefined && { interest_note: dto.interestNote }),
      };
      const before = { ...lead, phone: lead.primary_phone };
      const changes = diffFields(before, next, [
        'name',
        'phone',
        'email',
        'intent',
        'study_mode',
        'expected_closure_on',
        'interested_course_id',
        'interested_location_id',
        'interest_note',
      ]);
      if (changes.length === 0) return this.detail(trx, auth, id);

      const columns: Record<string, unknown> = { updated_by: auth.userId };
      for (const c of changes)
        columns[c.field === 'phone' ? 'primary_phone' : c.field] = next[c.field];
      await trx
        .updateTable('leads')
        .set(columns as never)
        .where('id', '=', id)
        .execute();

      for (const c of changes) {
        await this.writer.activity(trx, {
          tenantId: auth.tenantId,
          leadId: id,
          userId: auth.userId,
          type: 'field_change',
          field: c.field,
          oldValue: c.oldValue,
          newValue: c.newValue,
        });
      }
      return this.detail(trx, auth, id);
    });
  }

  addNote(auth: AuthContext, id: string, remark: string) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      await this.requireVisible(trx, auth, id);
      await this.writer.activity(trx, {
        tenantId: auth.tenantId,
        leadId: id,
        userId: auth.userId,
        type: 'note',
        remark,
      });
      await sql`UPDATE leads SET updated_at = now(), updated_by = ${auth.userId} WHERE id = ${id}`.execute(
        trx,
      );
      return { ok: true as const };
    });
  }

  // ----------------------------------------------------------------- status

  changeStatus(auth: AuthContext, id: string, dto: ChangeStatusDto) {
    return this.db.withTenant(auth.tenantId, (trx) => this.changeStatusIn(trx, auth, id, dto));
  }

  /** The same as changeStatus, inside the caller's transaction, so other work can succeed or fail together with it. */
  async changeStatusIn(trx: Trx, auth: AuthContext, id: string, dto: ChangeStatusDto) {
    {
      const lead = await this.lockVisible(trx, auth, id);
      if (dto.followUp && !auth.permissions.has('followup.manage')) throw AppError.forbidden();
      if (dto.followUp) assertFollowUpTime(dto.followUp.dueAt);

      const status = await this.requireStatus(trx, dto.statusId, dto.substatusId);
      const sameStatus =
        lead.status_id === status.id &&
        (dto.substatusId === undefined || dto.substatusId === lead.substatus_id);

      if (!sameStatus) {
        assertFollowUpForStatus(
          { name: status.name, requiresFollowup: status.requires_followup, isOpen: status.is_open },
          !!dto.followUp,
          await this.followUps.hasUpcoming(trx, id),
        );
        const oldStatus = await trx
          .selectFrom('lead_statuses')
          .select('name')
          .where('id', '=', lead.status_id)
          .executeTakeFirstOrThrow();
        await trx
          .updateTable('leads')
          .set({
            status_id: status.id,
            substatus_id: dto.substatusId ?? null,
            updated_by: auth.userId,
          })
          .where('id', '=', id)
          .execute();
        await this.writer.activity(trx, {
          tenantId: auth.tenantId,
          leadId: id,
          userId: auth.userId,
          type: 'status_change',
          field: 'status',
          oldValue: oldStatus.name,
          newValue: status.name + (status.substatus_name ? ` / ${status.substatus_name}` : ''),
          remark: dto.remark,
        });
        if (!status.is_open) await this.followUps.closeAll(trx, id);
      } else if (dto.remark) {
        await this.writer.activity(trx, {
          tenantId: auth.tenantId,
          leadId: id,
          userId: auth.userId,
          type: 'note',
          remark: dto.remark,
        });
      }

      if (dto.followUp && status.is_open) {
        await this.followUps.create(trx, {
          tenantId: auth.tenantId,
          leadId: id,
          userId: lead.assigned_to ?? auth.userId,
          dueAt: dto.followUp.dueAt,
          note: dto.followUp.note,
          remindBeforeMin: dto.followUp.remindBeforeMin,
        });
        await this.writer.activity(trx, {
          tenantId: auth.tenantId,
          leadId: id,
          userId: auth.userId,
          type: 'followup',
          newValue: dto.followUp.dueAt.toISOString(),
          remark: dto.followUp.note ?? 'Follow-up set',
        });
      }
      return this.detail(trx, auth, id);
    }
  }

  bulkStatus(auth: AuthContext, dto: BulkStatusDto) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const status = await this.requireStatus(trx, dto.statusId, dto.substatusId);
      if (status.requires_followup && status.is_open) {
        throw AppError.badRequest(
          'BULK_FOLLOWUP_STATUS',
          `"${status.name}" needs a follow-up date for each lead, so it cannot be set in bulk`,
        );
      }
      const leads = await this.lockMany(trx, auth, dto.leadIds);
      const changing = leads.filter(
        (l) =>
          l.status_id !== status.id ||
          (dto.substatusId !== undefined && dto.substatusId !== l.substatus_id),
      );

      for (const lead of changing) {
        await sql`UPDATE leads SET status_id = ${status.id}, substatus_id = ${dto.substatusId ?? null}, updated_by = ${auth.userId} WHERE id = ${lead.id}`.execute(
          trx,
        );
        const old = await trx
          .selectFrom('lead_statuses')
          .select('name')
          .where('id', '=', lead.status_id)
          .executeTakeFirstOrThrow();
        await this.writer.activity(trx, {
          tenantId: auth.tenantId,
          leadId: lead.id,
          userId: auth.userId,
          type: 'status_change',
          field: 'status',
          oldValue: old.name,
          newValue: status.name,
          remark: dto.remark,
        });
        if (!status.is_open) await this.followUps.closeAll(trx, lead.id);
      }
      return { requested: leads.length, changed: changing.length };
    });
  }

  // ----------------------------------------------------------------- assign

  assign(auth: AuthContext, id: string, dto: AssignDto) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const lead = await this.lockVisible(trx, auth, id);
      const target = dto.userId ? await this.assignable(trx, auth, dto.userId, dto.allowUnavailable) : null;
      if ((lead.assigned_to ?? null) !== (target?.id ?? null)) {
        await this.reassign(trx, auth, [lead], target);
      }
      return this.detail(trx, auth, id);
    });
  }

  bulkAssign(auth: AuthContext, dto: BulkAssignDto) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const target = dto.userId ? await this.assignable(trx, auth, dto.userId, dto.allowUnavailable) : null;
      const leads = await this.lockMany(trx, auth, dto.leadIds);
      const moving = leads.filter((l) => (l.assigned_to ?? null) !== (target?.id ?? null));
      if (moving.length > 0) await this.reassign(trx, auth, moving, target);
      return { requested: leads.length, changed: moving.length };
    });
  }

  // ----------------------------------------------------------------- delete

  remove(auth: AuthContext, id: string): Promise<void> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const lead = await this.lockVisible(trx, auth, id);
      await sql`UPDATE leads SET deleted_at = now(), updated_by = ${auth.userId} WHERE id = ${id}`.execute(
        trx,
      );
      await this.followUps.closeAll(trx, id);
      await this.writer.activity(trx, {
        tenantId: auth.tenantId,
        leadId: id,
        userId: auth.userId,
        type: 'field_change',
        field: 'deleted',
        oldValue: null,
        newValue: 'yes',
        remark: `Lead ${lead.lead_no} deleted by ${auth.name}`,
      });
    });
  }

  // ---------------------------------------------------------------- helpers

  private filters(auth: AuthContext, q: ListLeadsDto) {
    const c: ReturnType<typeof sql<SqlBool>>[] = [sql<SqlBool>`l.deleted_at IS NULL`];
    const visible = leadVisibility(auth);
    if (visible) c.push(visible as never);

    const term = q.q ? classifySearch(q.q) : null;
    if (term?.kind === 'lead_no') c.push(sql<SqlBool>`l.lead_no = ${term.value}::bigint`);
    else if (term?.kind === 'phone') {
      c.push(
        sql<SqlBool>`(l.primary_phone LIKE ${likePattern(term.value)} OR EXISTS (SELECT 1 FROM lead_phones x WHERE x.lead_id = l.id AND x.phone LIKE ${likePattern(term.value)}))`,
      );
    } else if (term?.kind === 'text') {
      c.push(
        sql<SqlBool>`(l.name ILIKE ${likePattern(term.value)} OR l.email ILIKE ${likePattern(term.value)})`,
      );
    }

    if (q.queue) c.push(sql<SqlBool>`${EFFECTIVE_QUEUE} = ${q.queue}`);
    if (q.statusId) c.push(sql<SqlBool>`l.status_id = ${q.statusId}::uuid`);
    if (q.sourceId) c.push(sql<SqlBool>`l.source_id = ${q.sourceId}::uuid`);
    if (q.intent) c.push(sql<SqlBool>`l.intent = ${q.intent}`);
    if (q.studyMode) c.push(sql<SqlBool>`l.study_mode = ${q.studyMode}`);
    if (q.assignedTo === 'me') c.push(sql<SqlBool>`l.assigned_to = ${auth.userId}::uuid`);
    else if (q.assignedTo === 'unassigned') c.push(sql<SqlBool>`l.assigned_to IS NULL`);
    else if (q.assignedTo) c.push(sql<SqlBool>`l.assigned_to = ${q.assignedTo}::uuid`);
    if (q.createdFrom)
      c.push(
        sql<SqlBool>`l.created_at >= (${q.createdFrom}::date::timestamp AT TIME ZONE t.timezone)`,
      );
    if (q.createdTo)
      c.push(
        sql<SqlBool>`l.created_at < ((${q.createdTo}::date + 1)::timestamp AT TIME ZONE t.timezone)`,
      );
    if (q.followup === 'overdue') c.push(sql<SqlBool>`s.is_open AND l.next_followup_at < now()`);
    if (q.followup === 'today')
      c.push(
        sql<SqlBool>`s.is_open AND l.next_followup_at >= now() AND (l.next_followup_at AT TIME ZONE t.timezone)::date = (now() AT TIME ZONE t.timezone)::date`,
      );
    if (q.followup === 'upcoming')
      c.push(
        sql<SqlBool>`s.is_open AND (l.next_followup_at AT TIME ZONE t.timezone)::date > (now() AT TIME ZONE t.timezone)::date`,
      );
    return c;
  }

  /** A lead the caller may see, or a 404. A 404 (not a 403) hides that it exists. */
  private async requireVisible(trx: Trx, auth: AuthContext, id: string): Promise<void> {
    const visible = leadVisibility(auth);
    const { rows } = await sql<{ id: string }>`
      SELECT l.id FROM leads l WHERE l.id = ${id} AND l.deleted_at IS NULL ${visible ? sql`AND ${visible}` : sql``}`.execute(
      trx,
    );
    if (!rows[0]) throw AppError.notFound('Lead');
  }

  /** The same, locked for the rest of the transaction because it is about to change. */
  private async lockVisible(trx: Trx, auth: AuthContext, id: string): Promise<LockedLead> {
    const rows = await this.lockMany(trx, auth, [id]).catch((e: unknown) => {
      if (e instanceof AppError && e.status === 404) throw AppError.notFound('Lead');
      throw e;
    });
    return rows[0]!;
  }

  private async lockMany(trx: Trx, auth: AuthContext, ids: string[]): Promise<LockedLead[]> {
    const visible = leadVisibility(auth);
    const { rows } = await sql<LockedLead>`
      SELECT l.id, l.lead_no::text AS lead_no, l.name, l.primary_phone, l.email, l.intent, l.study_mode,
             l.expected_closure_on::text AS expected_closure_on, l.interested_course_id, l.interested_location_id,
             l.interest_note, l.status_id, l.substatus_id, l.assigned_to, a.name AS assignee_name
      FROM leads l LEFT JOIN users a ON a.id = l.assigned_to
      WHERE l.id = ANY(${ids}::uuid[]) AND l.deleted_at IS NULL ${visible ? sql`AND ${visible}` : sql``}
      ORDER BY l.id
      FOR UPDATE OF l`.execute(trx);
    if (rows.length !== ids.length) {
      const found = new Set(rows.map((r) => r.id));
      const missing = ids.filter((i) => !found.has(i));
      throw new AppError(
        'LEADS_NOT_FOUND',
        `${missing.length} of the leads could not be found`,
        404,
        undefined,
        undefined,
        { missing },
      );
    }
    return rows;
  }

  private async detail(trx: Trx, auth: AuthContext, id: string) {
    const visible = leadVisibility(auth);
    const { rows } = await sql<DetailRow>`
      SELECT l.id, l.lead_no::text AS lead_no, l.name, l.primary_phone, l.email, l.intent, l.study_mode,
             l.expected_closure_on::text AS expected_closure_on, l.interest_note, l.next_followup_at, l.first_called_at,
             l.assigned_at, l.created_at, l.updated_at, l.assigned_to, a.name AS assignee_name,
             s.id AS status_id, s.name AS status_name, s.queue AS status_queue, s.is_open AS status_open,
             s.requires_followup, ${EFFECTIVE_QUEUE} AS queue, ss.id AS substatus_id, ss.name AS substatus_name,
             src.id AS source_id, src.name AS source_name,
             c.id AS course_id, c.name AS course_name, loc.id AS location_id, loc.name AS location_name, loc.type AS location_type,
             cb.name AS created_by_name,
             (SELECT count(*) FROM followups f WHERE f.lead_id = l.id AND f.done_at IS NULL) AS open_followups
      ${FROM_LEADS}
      LEFT JOIN lead_substatuses ss ON ss.id = l.substatus_id
      LEFT JOIN courses c ON c.id = l.interested_course_id
      LEFT JOIN locations loc ON loc.id = l.interested_location_id
      LEFT JOIN users cb ON cb.id = l.created_by
      WHERE l.id = ${id} AND l.deleted_at IS NULL ${visible ? sql`AND ${visible}` : sql``}`.execute(
      trx,
    );
    const r = rows[0];
    if (!r) throw AppError.notFound('Lead');

    const phones = await trx
      .selectFrom('lead_phones')
      .select(['id', 'phone', 'label'])
      .where('lead_id', '=', id)
      .execute();
    const { rows: enquiries } = await sql<{
      source: string;
      form_name: string | null;
      page_path: string | null;
      utm_source: string | null;
      utm_medium: string | null;
      utm_campaign: string | null;
      created_at: Date;
    }>`
      SELECT s.name AS source, e.form_name, e.page_path, e.utm_source, e.utm_medium, e.utm_campaign, e.created_at
      FROM lead_enquiries e JOIN lead_sources s ON s.id = e.source_id WHERE e.lead_id = ${id} ORDER BY e.created_at`.execute(
      trx,
    );

    return {
      id: r.id,
      leadNo: r.lead_no,
      name: r.name,
      phone: r.primary_phone,
      email: r.email,
      intent: r.intent,
      studyMode: r.study_mode,
      expectedClosureOn: r.expected_closure_on,
      interestNote: r.interest_note,
      status: {
        id: r.status_id,
        name: r.status_name,
        queue: r.status_queue,
        isOpen: r.status_open,
        requiresFollowup: r.requires_followup,
      },
      substatus: r.substatus_id ? { id: r.substatus_id, name: r.substatus_name! } : null,
      queue: r.queue,
      source: { id: r.source_id, name: r.source_name },
      assignedTo: r.assigned_to ? { id: r.assigned_to, name: r.assignee_name ?? '' } : null,
      assignedAt: r.assigned_at,
      interestedCourse: r.course_id ? { id: r.course_id, name: r.course_name! } : null,
      interestedLocation: r.location_id
        ? { id: r.location_id, name: r.location_name!, type: r.location_type! }
        : null,
      nextFollowupAt: r.next_followup_at,
      firstCalledAt: r.first_called_at,
      openFollowUps: Number(r.open_followups),
      createdBy: r.created_by_name,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      extraPhones: phones.map((p) => ({ id: p.id, phone: p.phone, label: p.label })),
      enquiries: enquiries.map((e) => ({
        source: e.source,
        formName: e.form_name,
        page: e.page_path,
        utm: { source: e.utm_source, medium: e.utm_medium, campaign: e.utm_campaign },
        at: e.created_at,
      })),
    };
  }

  private async findByPhone(trx: Trx, phone: string) {
    const { rows } = await sql<{
      id: string;
      lead_no: string;
      name: string;
      assignee_name: string | null;
    }>`
      SELECT l.id, l.lead_no::text AS lead_no, l.name, a.name AS assignee_name
      FROM leads l LEFT JOIN users a ON a.id = l.assigned_to
      WHERE l.deleted_at IS NULL
        AND (l.primary_phone = ${phone} OR EXISTS (SELECT 1 FROM lead_phones x WHERE x.lead_id = l.id AND x.phone = ${phone}))
      LIMIT 1`.execute(trx);
    return rows[0];
  }

  /** The person who will own a new lead. */
  private async chooseAssignee(
    trx: Trx,
    auth: AuthContext,
    dto: CreateLeadDto,
    sourceId: string,
  ): Promise<string | null> {
    if (!auth.permissions.has('lead.assign')) return auth.userId; // whoever adds a lead owns it
    if (dto.assignTo === null) return null;
    if (dto.assignTo) return (await this.assignable(trx, auth, dto.assignTo, dto.allowUnavailable)).id;

    const policy = await this.writer.policy(trx);
    if (!policy.autoAssign) return null;
    const choice = await this.assignment.choose(trx, auth.tenantId, {
      sourceId,
      courseId: dto.interestedCourseId ?? null,
      locationId: dto.interestedLocationId ?? null,
      studyMode: dto.studyMode ?? null,
    });
    return choice.userId;
  }

  private assignable(trx: Trx, auth: AuthContext, userId: string, allowUnavailable?: boolean) {
    return this.assignees.ensure(trx, auth, userId, { allowUnavailable });
  }

  /** Moves leads to a new owner (or to nobody), with history, follow-ups and a notification. */
  private async reassign(
    trx: Trx,
    auth: AuthContext,
    leads: LockedLead[],
    target: { id: string; name: string } | null,
  ): Promise<void> {
    const ids = leads.map((l) => l.id);
    await sql`
      UPDATE leads SET assigned_to = ${target?.id ?? null},
                       assigned_at = ${target ? sql`clock_timestamp()` : null}, updated_by = ${auth.userId}
      WHERE id = ANY(${ids}::uuid[])`.execute(trx);
    // Open follow-ups belong to whoever now owns the lead.
    if (target)
      await sql`UPDATE followups SET user_id = ${target.id} WHERE lead_id = ANY(${ids}::uuid[]) AND done_at IS NULL`.execute(
        trx,
      );

    for (const lead of leads) {
      await this.writer.activity(trx, {
        tenantId: auth.tenantId,
        leadId: lead.id,
        userId: auth.userId,
        type: 'assignment',
        field: 'assigned_to',
        oldValue: lead.assignee_name,
        newValue: target?.name ?? null,
        remark: `By ${auth.name}`,
      });
    }
    if (target && target.id !== auth.userId) {
      await this.notifications.notify(trx, {
        tenantId: auth.tenantId,
        userIds: [target.id],
        type: 'assignment',
        payload:
          leads.length === 1
            ? {
                event: 'lead_assigned',
                leadId: leads[0]!.id,
                leadNo: leads[0]!.lead_no,
                name: leads[0]!.name,
                by: auth.name,
              }
            : { event: 'leads_assigned', count: leads.length, by: auth.name },
      });
    }
  }

  private async recordAssignment(
    trx: Trx,
    auth: AuthContext,
    leadId: string,
    leadNo: string,
    from: string | null,
    toUserId: string,
    remark: string,
  ): Promise<void> {
    const to = await trx
      .selectFrom('users')
      .select('name')
      .where('id', '=', toUserId)
      .executeTakeFirstOrThrow();
    await this.writer.activity(trx, {
      tenantId: auth.tenantId,
      leadId,
      userId: auth.userId,
      type: 'assignment',
      field: 'assigned_to',
      oldValue: from,
      newValue: to.name,
      remark,
    });
    if (toUserId !== auth.userId) {
      await this.notifications.notify(trx, {
        tenantId: auth.tenantId,
        userIds: [toUserId],
        type: 'assignment',
        payload: { event: 'lead_assigned', leadId, leadNo, by: auth.name },
      });
    }
  }

  private async requireStatus(trx: Trx, statusId: string, substatusId: string | null | undefined) {
    const { rows } = await sql<{
      id: string;
      name: string;
      is_open: boolean;
      requires_followup: boolean;
      substatus_name: string | null;
    }>`
      SELECT s.id, s.name, s.is_open, s.requires_followup, ss.name AS substatus_name
      FROM lead_statuses s
      LEFT JOIN lead_substatuses ss ON ss.id = ${substatusId ?? null}::uuid AND ss.status_id = s.id
      WHERE s.id = ${statusId} AND s.is_active
        AND (${substatusId ?? null}::uuid IS NULL OR ss.id IS NOT NULL)`.execute(trx);
    if (!rows[0])
      throw invalid(
        'STATUS_INVALID',
        'statusId',
        'Choose a status that is in use (and a sub-status that belongs to it)',
      );
    return rows[0];
  }

  private async assertExists(
    trx: Trx,
    table: 'courses' | 'locations',
    id: string | null | undefined,
    field: string,
  ): Promise<void> {
    if (!id) return;
    const found = await trx.selectFrom(table).select('id').where('id', '=', id).executeTakeFirst();
    if (!found) throw invalid('REFERENCE_INVALID', field, 'Choose one from the list');
  }
}

// ---------------------------------------------------------------- mapping

export interface ActivityView {
  id: string;
  type: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  remark: string | null;
  user: { id: string; name: string } | null;
  createdAt: Date;
}

interface DetailRow extends Omit<ListRow, 'sort_key'> {
  first_called_at: Date | null;
  assigned_at: Date | null;
  requires_followup: boolean;
  substatus_id: string | null;
  substatus_name: string | null;
  course_id: string | null;
  course_name: string | null;
  location_id: string | null;
  location_name: string | null;
  location_type: string | null;
  created_by_name: string | null;
  open_followups: string;
}

function toListItem(r: ListRow): LeadListItem {
  return {
    id: r.id,
    leadNo: r.lead_no,
    name: r.name,
    phone: r.primary_phone,
    email: r.email,
    intent: r.intent,
    studyMode: r.study_mode,
    status: { id: r.status_id, name: r.status_name, queue: r.status_queue, isOpen: r.status_open },
    queue: r.queue,
    source: { id: r.source_id, name: r.source_name },
    assignedTo: r.assigned_to ? { id: r.assigned_to, name: r.assignee_name ?? '' } : null,
    nextFollowupAt: r.next_followup_at,
    expectedClosureOn: r.expected_closure_on,
    interestNote: r.interest_note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const invalid = (code: string, field: string, message: string) =>
  AppError.badRequest(code, message, [{ field, message }]);

const duplicateError = (existing: {
  id: string;
  lead_no: string;
  name: string;
  assignee_name: string | null;
}) =>
  AppError.conflict('DUPLICATE_LEAD', 'A lead with this phone number already exists', {
    existing: {
      id: existing.id,
      leadNo: existing.lead_no,
      name: existing.name,
      assignedTo: existing.assignee_name,
    },
  });
