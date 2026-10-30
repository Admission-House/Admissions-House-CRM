import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppError } from '../common/app-error.js';
import { DatabaseService, Trx } from '../database/database.service.js';
import type { CreateBreakTypeDto, UpdateBreakTypeDto, UpdateSettingsDto } from './attendance.dto.js';
import { AttendanceRepository, SettingsRow } from './attendance.repository.js';

export interface SettingsView {
  id: string;
  effectiveFrom: string;
  shiftStart: string;
  shiftEnd: string;
  graceMinutes: number;
  halfDayBelowHours: number;
  idleTimeoutMin: number;
  weeklyOffDays: number[];
}

export interface BreakTypeView {
  id: string;
  name: string;
  allowedMinutes: number;
  isActive: boolean;
}

@Injectable()
export class AttendanceSettingsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly repo: AttendanceRepository,
    private readonly audit: AuditService,
  ) {}

  /** What is in force now, what is coming, and what used to apply, so a past month can be explained. */
  get(auth: AuthContext) {
    return this.db.withTenant(auth.tenantId, async (trx) => this.snapshot(trx));
  }

  /**
   * Settings are never edited in place: a change adds a row that starts on a given day, so earlier
   * days keep the rules they were worked under. Saving twice for the same start day replaces that row.
   */
  update(auth: AuthContext, dto: UpdateSettingsDto) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const today = await this.repo.localToday(trx);
      const effectiveFrom = dto.effectiveFrom ?? today;
      if (effectiveFrom < today) {
        throw AppError.badRequest('DATE_IN_PAST', 'New settings cannot start in the past', [{ field: 'effectiveFrom', message: 'Choose today or a later day' }]);
      }
      const before = await this.snapshot(trx);

      await sql`
        INSERT INTO attendance_settings
          (tenant_id, effective_from, shift_start, shift_end, grace_minutes, half_day_below_hours,
           idle_timeout_min, weekly_off_days, created_by)
        VALUES (${auth.tenantId}, ${effectiveFrom}::date, ${dto.shiftStart}::time, ${dto.shiftEnd}::time,
                ${dto.graceMinutes}, ${dto.halfDayBelowHours}, ${dto.idleTimeoutMin},
                ${dto.weeklyOffDays}::smallint[], ${auth.userId})
        ON CONFLICT (tenant_id, effective_from) DO UPDATE SET
          shift_start = EXCLUDED.shift_start, shift_end = EXCLUDED.shift_end, grace_minutes = EXCLUDED.grace_minutes,
          half_day_below_hours = EXCLUDED.half_day_below_hours, idle_timeout_min = EXCLUDED.idle_timeout_min,
          weekly_off_days = EXCLUDED.weekly_off_days, created_by = EXCLUDED.created_by`.execute(trx);

      const after = await this.snapshot(trx);
      await this.audit.write(trx, {
        tenantId: auth.tenantId, actorId: auth.userId, action: 'attendance.settings', entity: 'attendance_settings',
        before: before.current, after: { ...dto, effectiveFrom }, ip: auth.ip, requestId: auth.requestId,
      });
      return after;
    });
  }

  // ------------------------------------------------------------ break types

  listBreakTypes(auth: AuthContext, includeInactive: boolean): Promise<BreakTypeView[]> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      let qb = trx.selectFrom('break_types').select(['id', 'name', 'allowed_minutes', 'is_active']).orderBy('name');
      if (!includeInactive) qb = qb.where('is_active', '=', true);
      return (await qb.execute()).map(toBreakType);
    });
  }

  createBreakType(auth: AuthContext, dto: CreateBreakTypeDto): Promise<BreakTypeView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      await this.assertNameFree(trx, dto.name);
      const row = await trx
        .insertInto('break_types')
        .values({ tenant_id: auth.tenantId, name: dto.name, allowed_minutes: dto.allowedMinutes })
        .returning(['id', 'name', 'allowed_minutes', 'is_active'])
        .executeTakeFirstOrThrow();
      await this.audit.write(trx, {
        tenantId: auth.tenantId, actorId: auth.userId, action: 'break_type.create', entity: 'break_type', entityId: row.id,
        after: dto, ip: auth.ip, requestId: auth.requestId,
      });
      return toBreakType(row);
    });
  }

  updateBreakType(auth: AuthContext, id: string, dto: UpdateBreakTypeDto): Promise<BreakTypeView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const before = await trx.selectFrom('break_types').select(['id', 'name', 'allowed_minutes', 'is_active']).where('id', '=', id).executeTakeFirst();
      if (!before) throw AppError.notFound('Break type');
      if (dto.name && dto.name.toLowerCase() !== before.name.toLowerCase()) await this.assertNameFree(trx, dto.name);

      const after = await trx
        .updateTable('break_types')
        .set({
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.allowedMinutes !== undefined && { allowed_minutes: dto.allowedMinutes }),
          ...(dto.isActive !== undefined && { is_active: dto.isActive }),
        })
        .where('id', '=', id)
        .returning(['id', 'name', 'allowed_minutes', 'is_active'])
        .executeTakeFirstOrThrow();
      await this.audit.write(trx, {
        tenantId: auth.tenantId, actorId: auth.userId, action: 'break_type.update', entity: 'break_type', entityId: id,
        before: toBreakType(before), after: toBreakType(after), ip: auth.ip, requestId: auth.requestId,
      });
      return toBreakType(after);
    });
  }

  // ---------------------------------------------------------------- helpers

  private async snapshot(trx: Trx) {
    const today = await this.repo.localToday(trx);
    const { rows } = await sql<SettingsRow>`
      SELECT id, effective_from::text AS effective_from, shift_start::text AS shift_start, shift_end::text AS shift_end,
             grace_minutes, half_day_below_hours::text AS half_day_below_hours, idle_timeout_min,
             weekly_off_days::int[] AS weekly_off_days
      FROM attendance_settings ORDER BY effective_from DESC`.execute(trx);
    const views = rows.map(toSettings);
    const current = views.find((v) => v.effectiveFrom <= today) ?? null;
    return {
      current,
      upcoming: views.filter((v) => v.effectiveFrom > today).reverse(),
      history: views.filter((v) => v.effectiveFrom <= today && v.id !== current?.id),
      breakTypes: (await trx.selectFrom('break_types').select(['id', 'name', 'allowed_minutes', 'is_active']).orderBy('name').execute()).map(toBreakType),
    };
  }

  private async assertNameFree(trx: Trx, name: string): Promise<void> {
    const taken = await trx.selectFrom('break_types').select('id').where(sql`lower(name)`, '=', name.toLowerCase()).executeTakeFirst();
    if (taken) throw AppError.conflict('BREAK_TYPE_EXISTS', 'A break with this name already exists');
  }
}

function toSettings(r: SettingsRow): SettingsView {
  return {
    id: r.id,
    effectiveFrom: r.effective_from,
    shiftStart: r.shift_start.slice(0, 5),
    shiftEnd: r.shift_end.slice(0, 5),
    graceMinutes: r.grace_minutes,
    halfDayBelowHours: Number(r.half_day_below_hours),
    idleTimeoutMin: r.idle_timeout_min,
    weeklyOffDays: r.weekly_off_days,
  };
}

function toBreakType(r: { id: string; name: string; allowed_minutes: number; is_active: boolean }): BreakTypeView {
  return { id: r.id, name: r.name, allowedMinutes: r.allowed_minutes, isActive: r.is_active };
}
