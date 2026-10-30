import { Injectable } from '@nestjs/common';
import { sql, SqlBool } from 'kysely';
import { z } from 'zod';
import { scopeCondition } from '../access/scope.js';
import { AttendanceRepository } from '../attendance/attendance.repository.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppError } from '../common/app-error.js';
import { decodeCursor, Page, toPage } from '../common/pagination.js';
import { DatabaseService, Trx } from '../database/database.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type {
  CreateLeaveRequestDto,
  CreateLeaveTypeDto,
  DecisionDto,
  ListLeaveRequestsDto,
  UpdateLeaveTypeDto,
} from './leave.dto.js';
import { assertSingleYear, availableDays, countLeaveDays } from './leave-rules.js';

/** How far back a leave may start. Older time off is a correction for an Admin, not a request. */
const MAX_BACKDATE_DAYS = 31;

export interface LeaveTypeView {
  id: string;
  name: string;
  isPaid: boolean;
  yearlyQuota: number;
  isActive: boolean;
}

export interface LeaveRequestView {
  id: string;
  user: { id: string; name: string };
  leaveType: { id: string; name: string; isPaid: boolean };
  fromDate: string;
  toDate: string;
  days: number;
  reason: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  createdAt: Date;
}

interface RequestRow {
  id: string;
  user_id: string;
  user_name: string;
  type_id: string;
  type_name: string;
  is_paid: boolean;
  from_date: string;
  to_date: string;
  days: number;
  reason: string | null;
  status: LeaveRequestView['status'];
  decided_by_name: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  created_at: Date;
}

const cursorShape = z.object({ d: z.string(), i: z.string() });

@Injectable()
export class LeaveService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly attendance: AttendanceRepository,
    private readonly notifications: NotificationsService,
  ) {}

  // ------------------------------------------------------------------ types

  listTypes(auth: AuthContext, includeInactive: boolean): Promise<LeaveTypeView[]> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      let qb = trx.selectFrom('leave_types').select(['id', 'name', 'is_paid', 'yearly_quota', 'is_active']).orderBy('name');
      if (!includeInactive) qb = qb.where('is_active', '=', true);
      return (await qb.execute()).map(toType);
    });
  }

  createType(auth: AuthContext, dto: CreateLeaveTypeDto): Promise<LeaveTypeView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      await this.assertTypeNameFree(trx, dto.name);
      const row = await trx
        .insertInto('leave_types')
        .values({ tenant_id: auth.tenantId, name: dto.name, is_paid: dto.isPaid, yearly_quota: dto.yearlyQuota })
        .returning(['id', 'name', 'is_paid', 'yearly_quota', 'is_active'])
        .executeTakeFirstOrThrow();
      await this.record(trx, auth, 'leave_type.create', 'leave_type', row.id, undefined, dto);
      return toType(row);
    });
  }

  updateType(auth: AuthContext, id: string, dto: UpdateLeaveTypeDto): Promise<LeaveTypeView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const before = await trx.selectFrom('leave_types').select(['id', 'name', 'is_paid', 'yearly_quota', 'is_active']).where('id', '=', id).executeTakeFirst();
      if (!before) throw AppError.notFound('Leave type');
      if (dto.name && dto.name.toLowerCase() !== before.name.toLowerCase()) await this.assertTypeNameFree(trx, dto.name);
      const after = await trx
        .updateTable('leave_types')
        .set({
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.isPaid !== undefined && { is_paid: dto.isPaid }),
          ...(dto.yearlyQuota !== undefined && { yearly_quota: dto.yearlyQuota }),
          ...(dto.isActive !== undefined && { is_active: dto.isActive }),
        })
        .where('id', '=', id)
        .returning(['id', 'name', 'is_paid', 'yearly_quota', 'is_active'])
        .executeTakeFirstOrThrow();
      await this.record(trx, auth, 'leave_type.update', 'leave_type', id, toType(before), toType(after));
      return toType(after);
    });
  }

  // --------------------------------------------------------------- balances

  /**
   * Each leave type with the person's quota, what is left, what is waiting for a decision and what
   * they can still ask for. Someone can read another person's balance only inside their own scope.
   */
  balances(auth: AuthContext, query: { year?: number; userId?: string }) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const userId = query.userId ?? auth.userId;
      if (userId !== auth.userId) await this.assertCanSee(trx, auth, userId);
      const year = query.year ?? (await this.currentYear(trx));
      return { userId, year, balances: await this.balanceRows(trx, userId, year) };
    });
  }

  private async balanceRows(trx: Trx, userId: string, year: number) {
    const { rows } = await sql<{ id: string; name: string; is_paid: boolean; quota: number; balance: number; pending: number }>`
      SELECT lt.id, lt.name, lt.is_paid, lt.yearly_quota::float8 AS quota,
             COALESCE(b.balance, lt.yearly_quota)::float8 AS balance,
             COALESCE((SELECT sum(r.days) FROM leave_requests r
                       WHERE r.user_id = ${userId} AND r.leave_type_id = lt.id AND r.status = 'pending'
                         AND EXTRACT(YEAR FROM r.from_date) = ${year}), 0)::float8 AS pending
      FROM leave_types lt
      LEFT JOIN leave_balances b ON b.leave_type_id = lt.id AND b.user_id = ${userId} AND b.year = ${year}
      WHERE lt.is_active
      ORDER BY lt.name`.execute(trx);
    return rows.map((r) => ({
      leaveType: { id: r.id, name: r.name, isPaid: r.is_paid },
      yearlyQuota: r.quota,
      remaining: r.balance,
      pending: r.pending,
      available: r.is_paid ? availableDays(r.balance, r.pending) : null,
    }));
  }

  // --------------------------------------------------------------- requests

  create(auth: AuthContext, dto: CreateLeaveRequestDto): Promise<LeaveRequestView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const type = await trx.selectFrom('leave_types').select(['id', 'name', 'is_paid', 'is_active']).where('id', '=', dto.leaveTypeId).executeTakeFirst();
      if (!type || !type.is_active) {
        throw AppError.badRequest('LEAVE_TYPE_INVALID', 'Choose a kind of leave that is in use', [{ field: 'leaveTypeId', message: 'Choose a kind of leave that is in use' }]);
      }

      assertSingleYear(dto.fromDate, dto.toDate);
      const today = await this.attendance.localToday(trx);
      const { rows: age } = await sql<{ days: number }>`SELECT (${today}::date - ${dto.fromDate}::date) AS days`.execute(trx);
      if (age[0]!.days > MAX_BACKDATE_DAYS) {
        throw AppError.badRequest('DATE_TOO_OLD', `Leave can start up to ${MAX_BACKDATE_DAYS} days in the past`, [{ field: 'fromDate', message: 'Choose a more recent day' }]);
      }

      const days = countLeaveDays({
        from: dto.fromDate,
        to: dto.toDate,
        weeklyOff: await this.weeklyOffOn(trx, dto.fromDate),
        holidays: await this.holidaysBetween(trx, dto.fromDate, dto.toDate),
        halfDay: dto.halfDay,
      });
      if (days === 0) {
        throw AppError.badRequest('NO_WORKING_DAYS', 'Those days are all weekly offs or holidays, so no leave is needed');
      }

      const year = Number(dto.fromDate.slice(0, 4));
      if (type.is_paid) {
        await this.ensureBalances(trx, auth.tenantId, auth.userId, year);
        const row = (await this.balanceRows(trx, auth.userId, year)).find((x) => x.leaveType.id === type.id);
        if (row && (row.available ?? 0) < days) {
          throw new AppError('INSUFFICIENT_BALANCE', `You have ${row.available} day(s) of ${type.name} available, and this needs ${days}`, 422);
        }
      }

      await this.assertNoOverlap(trx, auth.userId, dto.fromDate, dto.toDate);
      let id: string;
      try {
        id = (
          await trx
            .insertInto('leave_requests')
            .values({
              tenant_id: auth.tenantId, user_id: auth.userId, leave_type_id: type.id,
              from_date: dto.fromDate, to_date: dto.toDate, days, reason: dto.reason ?? null,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      } catch (err) {
        // Two requests made at the same moment: the database's own rule catches the second.
        if ((err as { code?: string }).code === '23P01') throw overlap();
        throw err;
      }

      await this.notifications.notify(trx, {
        tenantId: auth.tenantId,
        userIds: await this.notifications.approversOf(trx, auth.userId),
        type: 'approval',
        payload: { event: 'leave_requested', requestId: id, userId: auth.userId, userName: auth.name, leaveType: type.name, fromDate: dto.fromDate, toDate: dto.toDate, days },
      });
      await this.record(trx, auth, 'leave.request', 'leave_request', id, undefined, { type: type.name, from: dto.fromDate, to: dto.toDate, days });
      return this.one(trx, id);
    });
  }

  listMine(auth: AuthContext, query: ListLeaveRequestsDto) {
    return this.list(auth, query, false);
  }

  /** Requests of the people the caller manages (their own scope). */
  listForApproval(auth: AuthContext, query: ListLeaveRequestsDto) {
    return this.list(auth, query, true);
  }

  decide(auth: AuthContext, id: string, dto: DecisionDto): Promise<LeaveRequestView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const request = await this.lockForUpdate(trx, id, scopeCondition(auth, 'lr.user_id'));
      if (request.user_id === auth.userId) throw new AppError('SELF_APPROVAL', 'Another person must decide on your leave', 403);
      if (request.status !== 'pending') throw AppError.conflict('ALREADY_DECIDED', `This request is already ${request.status}`);

      if (dto.decision === 'approved' && request.is_paid) {
        await this.spendBalance(trx, auth.tenantId, request, -1);
      }
      await trx
        .updateTable('leave_requests')
        .set({ status: dto.decision, decided_by: auth.userId, decided_at: sql`now()`, decision_note: dto.note ?? null })
        .where('id', '=', id)
        .execute();

      await this.notifications.notify(trx, {
        tenantId: auth.tenantId,
        userIds: [request.user_id],
        type: 'approval',
        payload: { event: 'leave_decided', requestId: id, decision: dto.decision, decidedBy: auth.name, note: dto.note ?? null, fromDate: request.from_date, toDate: request.to_date },
      });
      await this.record(trx, auth, `leave.${dto.decision}`, 'leave_request', id, { status: 'pending' }, { status: dto.decision, note: dto.note ?? null });
      return this.one(trx, id);
    });
  }

  /** The person withdraws their own request. An approved leave that has not started gives its days back. */
  cancel(auth: AuthContext, id: string): Promise<LeaveRequestView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      // Only the person's own request can be cancelled, whatever their data scope.
      const request = await this.lockForUpdate(trx, id, sql<SqlBool>`lr.user_id = ${auth.userId}::uuid`);
      if (request.status !== 'pending' && request.status !== 'approved') {
        throw AppError.conflict('NOT_CANCELLABLE', `A ${request.status} request cannot be cancelled`);
      }
      if (request.status === 'approved') {
        const today = await this.attendance.localToday(trx);
        if (request.from_date <= today) throw AppError.conflict('LEAVE_STARTED', 'This leave has already started, so it cannot be cancelled');
        if (request.is_paid) await this.spendBalance(trx, auth.tenantId, request, +1);
      }
      await trx.updateTable('leave_requests').set({ status: 'cancelled' }).where('id', '=', id).execute();
      await this.record(trx, auth, 'leave.cancel', 'leave_request', id, { status: request.status }, { status: 'cancelled' });
      return this.one(trx, id);
    });
  }

  // ---------------------------------------------------------------- helpers

  private list(auth: AuthContext, query: ListLeaveRequestsDto, forApproval: boolean): Promise<Page<LeaveRequestView>> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const after = decodeCursor(query.cursor, cursorShape);
      const conditions = [sql<SqlBool>`true`];
      if (forApproval) {
        const scoped = scopeCondition(auth, 'lr.user_id');
        if (scoped) conditions.push(scoped as never);
        if (query.userId) conditions.push(sql<SqlBool>`lr.user_id = ${query.userId}::uuid`);
      } else {
        conditions.push(sql<SqlBool>`lr.user_id = ${auth.userId}::uuid`);
      }
      if (query.status) conditions.push(sql<SqlBool>`lr.status = ${query.status}`);
      if (query.from) conditions.push(sql<SqlBool>`lr.to_date >= ${query.from}::date`);
      if (query.to) conditions.push(sql<SqlBool>`lr.from_date <= ${query.to}::date`);
      if (after) conditions.push(sql<SqlBool>`(lr.from_date, lr.id) < (${after.d}::date, ${after.i}::uuid)`);

      const { rows } = await sql<RequestRow>`
        ${REQUEST_SELECT}
        WHERE ${sql.join(conditions, sql` AND `)}
        ORDER BY lr.from_date DESC, lr.id DESC
        LIMIT ${query.limit + 1}`.execute(trx);
      const page = toPage(rows, query.limit, (last) => ({ d: last.from_date, i: last.id }));
      return { items: page.items.map(toRequest), nextCursor: page.nextCursor };
    });
  }

  private async one(trx: Trx, id: string): Promise<LeaveRequestView> {
    const { rows } = await sql<RequestRow>`${REQUEST_SELECT} WHERE lr.id = ${id}`.execute(trx);
    return toRequest(rows[0]!);
  }

  /** The request, locked against a second decision at the same moment. Not matching `visible` is a 404. */
  private async lockForUpdate(trx: Trx, id: string, visible: ReturnType<typeof scopeCondition>) {
    const { rows } = await sql<{
      id: string; user_id: string; status: string; days: number; from_date: string; to_date: string; leave_type_id: string; is_paid: boolean;
    }>`
      SELECT lr.id, lr.user_id, lr.status, lr.days::float8 AS days, lr.from_date::text AS from_date, lr.to_date::text AS to_date,
             lr.leave_type_id, lt.is_paid
      FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id
      WHERE lr.id = ${id} ${visible ? sql`AND ${visible}` : sql``}
      FOR UPDATE OF lr`.execute(trx);
    if (!rows[0]) throw AppError.notFound('Leave request');
    return rows[0];
  }

  /** Takes days from (direction -1) or gives days back to (+1) the balance of the request's year. */
  private async spendBalance(trx: Trx, tenantId: string, request: { user_id: string; leave_type_id: string; from_date: string; days: number }, direction: 1 | -1) {
    const year = Number(request.from_date.slice(0, 4));
    await this.ensureBalances(trx, tenantId, request.user_id, year);
    const { rows } = await sql<{ balance: number }>`
      SELECT balance::float8 AS balance FROM leave_balances
      WHERE user_id = ${request.user_id} AND leave_type_id = ${request.leave_type_id} AND year = ${year}
      FOR UPDATE`.execute(trx);
    const current = rows[0]?.balance ?? 0;
    if (direction === -1 && current < request.days) {
      throw new AppError('INSUFFICIENT_BALANCE', `Only ${current} day(s) are left, and this request needs ${request.days}`, 422);
    }
    await sql`
      UPDATE leave_balances SET balance = balance + ${direction * request.days}
      WHERE user_id = ${request.user_id} AND leave_type_id = ${request.leave_type_id} AND year = ${year}`.execute(trx);
  }

  /** Makes sure a person has a balance row for every kind of leave in use for the year. */
  private async ensureBalances(trx: Trx, tenantId: string, userId: string, year: number): Promise<void> {
    await sql`
      INSERT INTO leave_balances (tenant_id, user_id, leave_type_id, year, balance)
      SELECT ${tenantId}, ${userId}, lt.id, ${year}, lt.yearly_quota FROM leave_types lt WHERE lt.is_active
      ON CONFLICT (user_id, leave_type_id, year) DO NOTHING`.execute(trx);
  }

  private async assertNoOverlap(trx: Trx, userId: string, from: string, to: string): Promise<void> {
    const { rows } = await sql<{ id: string }>`
      SELECT id FROM leave_requests
      WHERE user_id = ${userId} AND status IN ('pending', 'approved')
        AND daterange(from_date, to_date, '[]') && daterange(${from}::date, ${to}::date, '[]')
      LIMIT 1`.execute(trx);
    if (rows[0]) throw overlap();
  }

  private async weeklyOffOn(trx: Trx, date: string): Promise<number[]> {
    const { rows } = await sql<{ days: number[] }>`
      SELECT weekly_off_days::int[] AS days FROM attendance_settings
      WHERE effective_from <= ${date}::date ORDER BY effective_from DESC LIMIT 1`.execute(trx);
    return rows[0]?.days ?? [];
  }

  private async holidaysBetween(trx: Trx, from: string, to: string): Promise<Set<string>> {
    const { rows } = await sql<{ d: string }>`
      SELECT holiday_date::text AS d FROM holidays WHERE holiday_date BETWEEN ${from}::date AND ${to}::date`.execute(trx);
    return new Set(rows.map((r) => r.d));
  }

  private async currentYear(trx: Trx): Promise<number> {
    return Number((await this.attendance.localToday(trx)).slice(0, 4));
  }

  /** The caller may look at another person only inside their own scope; otherwise they do not exist. */
  private async assertCanSee(trx: Trx, auth: AuthContext, userId: string): Promise<void> {
    if (!auth.permissions.has('leave.read')) throw AppError.forbidden();
    let qb = trx.selectFrom('users as u').select('u.id').where('u.id', '=', userId);
    const scoped = scopeCondition(auth, 'u.id');
    if (scoped) qb = qb.where(scoped);
    if (!(await qb.executeTakeFirst())) throw AppError.notFound('Person');
  }

  private async assertTypeNameFree(trx: Trx, name: string): Promise<void> {
    const taken = await trx.selectFrom('leave_types').select('id').where(sql`lower(name)`, '=', name.toLowerCase()).executeTakeFirst();
    if (taken) throw AppError.conflict('LEAVE_TYPE_EXISTS', 'A kind of leave with this name already exists');
  }

  private record(trx: Trx, auth: AuthContext, action: string, entity: string, id: string, before: unknown, after: unknown) {
    return this.audit.write(trx, { tenantId: auth.tenantId, actorId: auth.userId, action, entity, entityId: id, before, after, ip: auth.ip, requestId: auth.requestId });
  }
}

const REQUEST_SELECT = sql`
  SELECT lr.id, lr.user_id, u.name AS user_name, lt.id AS type_id, lt.name AS type_name, lt.is_paid,
         lr.from_date::text AS from_date, lr.to_date::text AS to_date, lr.days::float8 AS days, lr.reason, lr.status,
         d.name AS decided_by_name, lr.decided_at, lr.decision_note, lr.created_at
  FROM leave_requests lr
  JOIN users u ON u.id = lr.user_id
  JOIN leave_types lt ON lt.id = lr.leave_type_id
  LEFT JOIN users d ON d.id = lr.decided_by`;

const overlap = () => AppError.conflict('LEAVE_OVERLAP', 'You already have leave that overlaps these days');

function toType(r: { id: string; name: string; is_paid: boolean; yearly_quota: string | number; is_active: boolean }): LeaveTypeView {
  return { id: r.id, name: r.name, isPaid: r.is_paid, yearlyQuota: Number(r.yearly_quota), isActive: r.is_active };
}

function toRequest(r: RequestRow): LeaveRequestView {
  return {
    id: r.id,
    user: { id: r.user_id, name: r.user_name },
    leaveType: { id: r.type_id, name: r.type_name, isPaid: r.is_paid },
    fromDate: r.from_date,
    toDate: r.to_date,
    days: r.days,
    reason: r.reason,
    status: r.status,
    decidedBy: r.decided_by_name,
    decidedAt: r.decided_at,
    decisionNote: r.decision_note,
    createdAt: r.created_at,
  };
}
