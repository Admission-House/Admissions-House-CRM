import { Injectable } from '@nestjs/common';
import { sql, SqlBool } from 'kysely';
import { z } from 'zod';
import { scopeCondition } from '../access/scope.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppError } from '../common/app-error.js';
import { decodeCursor, Page, toPage } from '../common/pagination.js';
import { DatabaseService, Trx } from '../database/database.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type { CreateExceptionDto, ListAttendanceDto } from './attendance.dto.js';
import { AttendanceRepository } from './attendance.repository.js';

/** How far back an Admin may fill in a missed day. Older corrections are not allowed to be quiet. */
const MAX_BACKDATE_DAYS = 31;

export interface AttendanceView {
  id: string;
  user: { id: string; name: string };
  workDate: string;
  checkInAt: Date;
  checkOutAt: Date | null;
  checkOutReason: string | null;
  lateMinutes: number;
  method: 'office_check' | 'exception';
  /** Minutes between check-in and check-out (or now, if still in). */
  presentMinutes: number;
  breakMinutes: number;
  workedMinutes: number;
}

interface ListRow {
  id: string;
  user_id: string;
  user_name: string;
  work_date: string;
  check_in_at: Date;
  check_out_at: Date | null;
  check_out_reason: string | null;
  late_minutes: number;
  method: 'office_check' | 'exception';
  present_minutes: number;
  break_minutes: number;
}

const cursorShape = z.object({ d: z.string(), i: z.string() });

@Injectable()
export class AttendanceService {
  constructor(
    private readonly db: DatabaseService,
    private readonly repo: AttendanceRepository,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  // -------------------------------------------------------------- own day

  /** Where the signed-in person stands today: checked in, on a break, and the shift rules. */
  today(auth: AuthContext) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      if (!auth.tracksAttendance) return { tracked: false as const };

      const [today, settings] = await Promise.all([this.repo.localToday(trx), this.repo.currentSettings(trx)]);
      const { rows } = await sql<{
        id: string; work_date: string; check_in_at: Date; check_out_at: Date | null; late_minutes: number; method: string;
        break_id: string | null; break_started_at: Date | null; break_type_id: string | null; break_name: string | null;
        allowed_minutes: number | null; break_minutes: number;
      }>`
        SELECT a.id, a.work_date::text AS work_date, a.check_in_at, a.check_out_at, a.late_minutes, a.method,
               ob.id AS break_id, ob.started_at AS break_started_at, bt.id AS break_type_id, bt.name AS break_name,
               bt.allowed_minutes,
               COALESCE((SELECT floor(sum(EXTRACT(EPOCH FROM COALESCE(b.ended_at, now()) - b.started_at)) / 60)::int
                         FROM break_logs b WHERE b.attendance_id = a.id), 0) AS break_minutes
        FROM attendance_records a
        LEFT JOIN break_logs ob ON ob.attendance_id = a.id AND ob.ended_at IS NULL
        LEFT JOIN break_types bt ON bt.id = ob.break_type_id
        WHERE a.user_id = ${auth.userId} AND a.work_date = ${today}::date`.execute(trx);
      const r = rows[0];

      return {
        tracked: true as const,
        today,
        checkedIn: !!r && r.check_out_at === null,
        record: r && {
          id: r.id, workDate: r.work_date, checkInAt: r.check_in_at, checkOutAt: r.check_out_at,
          lateMinutes: r.late_minutes, method: r.method,
        },
        onBreak: r?.break_id
          ? { id: r.break_id, startedAt: r.break_started_at, type: { id: r.break_type_id, name: r.break_name, allowedMinutes: r.allowed_minutes } }
          : null,
        breakMinutesToday: r?.break_minutes ?? 0,
        shift: settings && {
          start: settings.shift_start.slice(0, 5),
          end: settings.shift_end.slice(0, 5),
          graceMinutes: settings.grace_minutes,
          idleTimeoutMin: settings.idle_timeout_min,
        },
      };
    });
  }

  // ---------------------------------------------------------------- breaks

  startBreak(auth: AuthContext, breakTypeId: string) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const open = await this.openAttendance(trx, auth);
      const type = await trx.selectFrom('break_types').select(['id', 'name', 'allowed_minutes', 'is_active']).where('id', '=', breakTypeId).executeTakeFirst();
      if (!type) throw AppError.notFound('Break type');
      if (!type.is_active) throw AppError.badRequest('BREAK_TYPE_INACTIVE', 'This kind of break is not in use');

      const running = await trx.selectFrom('break_logs').select('id').where('attendance_id', '=', open.id).where('ended_at', 'is', null).executeTakeFirst();
      if (running) throw AppError.conflict('BREAK_ALREADY_OPEN', 'You are already on a break. End it first.');

      const row = await trx
        .insertInto('break_logs')
        .values({ tenant_id: auth.tenantId, attendance_id: open.id, break_type_id: type.id })
        .returning(['id', 'started_at'])
        .executeTakeFirstOrThrow();
      return {
        id: row.id,
        startedAt: row.started_at,
        type: { id: type.id, name: type.name, allowedMinutes: type.allowed_minutes },
        usedTodayMinutes: await this.minutesUsed(trx, open.id, type.id),
      };
    });
  }

  endBreak(auth: AuthContext) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const open = await this.openAttendance(trx, auth);
      const ended = await trx
        .updateTable('break_logs')
        .set({ ended_at: sql`now()` })
        .where('attendance_id', '=', open.id)
        .where('ended_at', 'is', null)
        .returning(['id', 'started_at', 'ended_at', 'break_type_id'])
        .executeTakeFirst();
      if (!ended) throw AppError.conflict('NO_OPEN_BREAK', 'You are not on a break');

      const type = await trx.selectFrom('break_types').select(['id', 'name', 'allowed_minutes']).where('id', '=', ended.break_type_id).executeTakeFirstOrThrow();
      const used = await this.minutesUsed(trx, open.id, type.id);
      return {
        id: ended.id,
        startedAt: ended.started_at,
        endedAt: ended.ended_at,
        type: { id: type.id, name: type.name, allowedMinutes: type.allowed_minutes },
        usedTodayMinutes: used,
        /** Minutes over the day's allowance for this kind of break; 0 if within it. */
        overByMinutes: Math.max(0, used - type.allowed_minutes),
      };
    });
  }

  // ----------------------------------------------------------------- lists

  list(auth: AuthContext, query: ListAttendanceDto): Promise<Page<AttendanceView>> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const after = decodeCursor(query.cursor, cursorShape);
      const conditions = [sql<SqlBool>`true`];
      const scoped = scopeCondition(auth, 'a.user_id');
      if (scoped) conditions.push(scoped as never);
      if (query.from) conditions.push(sql<SqlBool>`a.work_date >= ${query.from}::date`);
      if (query.to) conditions.push(sql<SqlBool>`a.work_date <= ${query.to}::date`);
      if (query.userId) conditions.push(sql<SqlBool>`a.user_id = ${query.userId}::uuid`);
      if (query.branchId) conditions.push(sql<SqlBool>`a.branch_id = ${query.branchId}::uuid`);
      if (query.method) conditions.push(sql<SqlBool>`a.method = ${query.method}`);
      if (query.lateOnly) conditions.push(sql<SqlBool>`a.late_minutes > 0`);
      if (after) conditions.push(sql<SqlBool>`(a.work_date, a.id) < (${after.d}::date, ${after.i}::uuid)`);

      const { rows } = await sql<ListRow>`
        SELECT a.id, a.user_id, u.name AS user_name, a.work_date::text AS work_date, a.check_in_at, a.check_out_at,
               a.check_out_reason, a.late_minutes, a.method,
               floor(EXTRACT(EPOCH FROM COALESCE(a.check_out_at, now()) - a.check_in_at) / 60)::int AS present_minutes,
               COALESCE((SELECT floor(sum(EXTRACT(EPOCH FROM COALESCE(b.ended_at, now()) - b.started_at)) / 60)::int
                         FROM break_logs b WHERE b.attendance_id = a.id), 0) AS break_minutes
        FROM attendance_records a
        JOIN users u ON u.id = a.user_id
        WHERE ${sql.join(conditions, sql` AND `)}
        ORDER BY a.work_date DESC, a.id DESC
        LIMIT ${query.limit + 1}`.execute(trx);

      const page = toPage(rows, query.limit, (last) => ({ d: last.work_date, i: last.id }));
      return { items: page.items.map(toView), nextCursor: page.nextCursor };
    });
  }

  // ------------------------------------------------------------ exceptions

  /**
   * An Admin marks someone present for a day they could not sign in from the office. It is kept
   * separate from normal attendance, always shows a label and the reason, and is audited.
   */
  createException(auth: AuthContext, dto: CreateExceptionDto): Promise<AttendanceView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      if (dto.userId === auth.userId) {
        throw new AppError('SELF_EXCEPTION', 'Another person must mark your attendance', 403);
      }
      // Only people in the caller's scope, shown as "not found" otherwise.
      let qb = trx
        .selectFrom('users as u')
        .innerJoin('roles as r', 'r.id', 'u.role_id')
        .select(['u.id', 'u.branch_id', 'u.status', 'r.requires_office'])
        .where('u.id', '=', dto.userId);
      const scoped = scopeCondition(auth, 'u.id');
      if (scoped) qb = qb.where(scoped);
      const target = await qb.executeTakeFirst();
      if (!target) throw AppError.notFound('Person');
      if (!target.requires_office) {
        throw AppError.badRequest('NOT_TRACKED', 'Attendance is not recorded for this person');
      }

      const today = await this.repo.localToday(trx);
      if (dto.date > today) throw AppError.badRequest('DATE_IN_FUTURE', 'You cannot mark attendance for a future day', [{ field: 'date', message: 'Choose today or an earlier day' }]);
      const { rows: age } = await sql<{ days: number }>`SELECT (${today}::date - ${dto.date}::date) AS days`.execute(trx);
      if (age[0]!.days > MAX_BACKDATE_DAYS) {
        throw AppError.badRequest('DATE_TOO_OLD', `Attendance can be filled in for the last ${MAX_BACKDATE_DAYS} days only`, [{ field: 'date', message: `Choose a day within the last ${MAX_BACKDATE_DAYS} days` }]);
      }

      const existing = await trx.selectFrom('attendance_records').select('id').where('user_id', '=', dto.userId).where('work_date', '=', dto.date).executeTakeFirst();
      if (existing) throw AppError.conflict('ATTENDANCE_EXISTS', 'This person already has attendance for that day');

      const settings = await this.repo.currentSettings(trx);
      const checkInTime = dto.checkInTime ?? settings?.shift_start.slice(0, 5) ?? '10:00';
      const isToday = dto.date === today;
      const checkOutTime = dto.checkOutTime ?? (isToday ? undefined : (settings?.shift_end.slice(0, 5) ?? '19:00'));

      const { rows } = await sql<{ id: string }>`
        INSERT INTO attendance_records
          (tenant_id, user_id, work_date, branch_id, check_in_at, check_out_at, method, late_minutes, check_out_reason)
        SELECT ${auth.tenantId}, ${dto.userId}, ${dto.date}::date, ${target.branch_id},
               (${dto.date}::date + ${checkInTime}::time) AT TIME ZONE t.timezone,
               ${checkOutTime ? sql`(${dto.date}::date + ${checkOutTime}::time) AT TIME ZONE t.timezone` : sql`NULL`},
               'exception', 0, ${checkOutTime ? 'shift_end' : null}
        FROM tenants t
        RETURNING id`.execute(trx);
      const id = rows[0]!.id;

      await trx
        .insertInto('attendance_exceptions')
        .values({ tenant_id: auth.tenantId, attendance_id: id, requested_for: dto.userId, approved_by: auth.userId, reason: dto.reason })
        .execute();
      await this.audit.write(trx, {
        tenantId: auth.tenantId, actorId: auth.userId, action: 'attendance.exception', entity: 'attendance', entityId: id,
        after: { userId: dto.userId, date: dto.date, reason: dto.reason, checkInTime, checkOutTime: checkOutTime ?? null },
        ip: auth.ip, requestId: auth.requestId,
      });
      const { rows: who } = await sql<{ name: string }>`SELECT name FROM users WHERE id = ${dto.userId}::uuid`.execute(trx);
      await this.notifications.notifySuperAdmins(trx, {
        tenantId: auth.tenantId, exceptUserId: auth.userId,
        payload: { event: 'attendance_exception', userId: dto.userId, userName: who[0]?.name ?? '', date: dto.date, reason: dto.reason, byUserId: auth.userId },
      });

      return this.one(trx, id);
    });
  }

  // ---------------------------------------------------------------- helpers

  /** Today's open attendance record of the caller, or an error saying why there is none. */
  private async openAttendance(trx: Trx, auth: AuthContext): Promise<{ id: string }> {
    if (!auth.tracksAttendance) {
      throw AppError.badRequest('NOT_TRACKED', 'Attendance is not recorded for your role');
    }
    const open = await trx
      .selectFrom('attendance_records')
      .select('id')
      .where('user_id', '=', auth.userId)
      .where('check_out_at', 'is', null)
      .orderBy('work_date', 'desc')
      .executeTakeFirst();
    if (!open) throw AppError.conflict('NOT_CHECKED_IN', 'You are not checked in. Sign in from the office first.');
    return open;
  }

  private async minutesUsed(trx: Trx, attendanceId: string, breakTypeId: string): Promise<number> {
    const { rows } = await sql<{ m: number }>`
      SELECT COALESCE(floor(sum(EXTRACT(EPOCH FROM COALESCE(ended_at, now()) - started_at)) / 60)::int, 0) AS m
      FROM break_logs WHERE attendance_id = ${attendanceId} AND break_type_id = ${breakTypeId}`.execute(trx);
    return rows[0]!.m;
  }

  private async one(trx: Trx, id: string): Promise<AttendanceView> {
    const { rows } = await sql<ListRow>`
      SELECT a.id, a.user_id, u.name AS user_name, a.work_date::text AS work_date, a.check_in_at, a.check_out_at,
             a.check_out_reason, a.late_minutes, a.method,
             floor(EXTRACT(EPOCH FROM COALESCE(a.check_out_at, now()) - a.check_in_at) / 60)::int AS present_minutes,
             COALESCE((SELECT floor(sum(EXTRACT(EPOCH FROM COALESCE(b.ended_at, now()) - b.started_at)) / 60)::int
                       FROM break_logs b WHERE b.attendance_id = a.id), 0) AS break_minutes
      FROM attendance_records a JOIN users u ON u.id = a.user_id WHERE a.id = ${id}`.execute(trx);
    return toView(rows[0]!);
  }
}

function toView(r: ListRow): AttendanceView {
  return {
    id: r.id,
    user: { id: r.user_id, name: r.user_name },
    workDate: r.work_date,
    checkInAt: r.check_in_at,
    checkOutAt: r.check_out_at,
    checkOutReason: r.check_out_reason,
    lateMinutes: r.late_minutes,
    method: r.method,
    presentMinutes: Math.max(0, r.present_minutes),
    breakMinutes: r.break_minutes,
    workedMinutes: Math.max(0, r.present_minutes - r.break_minutes),
  };
}
