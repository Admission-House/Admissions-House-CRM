import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppError } from '../common/app-error.js';
import { DatabaseService, Trx } from '../database/database.service.js';
import type { CreateHolidayDto, CreateHolidaysDto, UpdateHolidayDto } from './leave.dto.js';
import { countLeaveDays } from './leave-rules.js';

export interface HolidayView {
  id: string;
  date: string;
  name: string;
}

@Injectable()
export class HolidaysService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /** Holidays of a calendar year (default: the current year in the company's time zone). */
  list(auth: AuthContext, year?: number): Promise<HolidayView[]> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const { rows } = await sql<HolidayView>`
        SELECT h.id, h.holiday_date::text AS date, h.name
        FROM holidays h, tenants t
        WHERE EXTRACT(YEAR FROM h.holiday_date) = COALESCE(${year ?? null}::int, EXTRACT(YEAR FROM now() AT TIME ZONE t.timezone))
        ORDER BY h.holiday_date`.execute(trx);
      return rows;
    });
  }

  create(auth: AuthContext, dto: CreateHolidayDto): Promise<HolidayView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const taken = await trx
        .selectFrom('holidays')
        .select('id')
        .where('holiday_date', '=', dto.date)
        .executeTakeFirst();
      if (taken)
        throw AppError.conflict('HOLIDAY_EXISTS', 'There is already a holiday on that day');
      const row = await trx
        .insertInto('holidays')
        .values({ tenant_id: auth.tenantId, holiday_date: dto.date, name: dto.name })
        .returning(['id', 'holiday_date', 'name'])
        .executeTakeFirstOrThrow();
      await this.record(trx, auth, 'holiday.create', row.id, undefined, dto);
      await this.recountLeave(trx, auth, [dto.date]);
      return { id: row.id, date: row.holiday_date, name: row.name };
    });
  }

  /**
   * Adds a list of holidays together. A date that already has a holiday (in the company or twice in the list) is skipped
   * and reported, so a list can be uploaded again safely.
   */
  createMany(
    auth: AuthContext,
    dto: CreateHolidaysDto,
  ): Promise<{ added: HolidayView[]; skipped: { date: string; name: string; reason: string }[] }> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const dates = [...new Set(dto.items.map((i) => i.date))];
      const taken = new Set(
        (
          await trx
            .selectFrom('holidays')
            .select(sql<string>`holiday_date::text`.as('d'))
            .where('holiday_date', 'in', dates)
            .execute()
        ).map((r) => r.d),
      );
      const added: HolidayView[] = [];
      const skipped: { date: string; name: string; reason: string }[] = [];
      for (const item of [...dto.items].sort((a, b) => a.date.localeCompare(b.date))) {
        if (taken.has(item.date)) {
          skipped.push({ ...item, reason: 'There is already a holiday on that day' });
          continue;
        }
        const row = await trx
          .insertInto('holidays')
          .values({ tenant_id: auth.tenantId, holiday_date: item.date, name: item.name })
          .returning(['id', 'holiday_date', 'name'])
          .executeTakeFirstOrThrow();
        taken.add(item.date);
        added.push({ id: row.id, date: row.holiday_date, name: row.name });
      }
      if (added.length > 0) {
        await this.record(trx, auth, 'holiday.create_many', added[0]!.id, undefined, {
          added: added.map((h) => `${h.date} ${h.name}`),
          skipped: skipped.length,
        });
        await this.recountLeave(
          trx,
          auth,
          added.map((h) => h.date),
        );
      }
      return { added, skipped };
    });
  }

  update(auth: AuthContext, id: string, dto: UpdateHolidayDto): Promise<HolidayView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const before = await trx
        .selectFrom('holidays')
        .select(['id', 'holiday_date', 'name'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (!before) throw AppError.notFound('Holiday');
      await trx.updateTable('holidays').set({ name: dto.name }).where('id', '=', id).execute();
      await this.record(trx, auth, 'holiday.update', id, { name: before.name }, { name: dto.name });
      return { id, date: before.holiday_date, name: dto.name };
    });
  }

  remove(auth: AuthContext, id: string): Promise<void> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const removed = await trx
        .deleteFrom('holidays')
        .where('id', '=', id)
        .returning(['holiday_date', 'name'])
        .executeTakeFirst();
      if (!removed) throw AppError.notFound('Holiday');
      await this.record(
        trx,
        auth,
        'holiday.delete',
        id,
        { date: removed.holiday_date, name: removed.name },
        undefined,
      );
      await this.recountLeave(trx, auth, [String(removed.holiday_date)]);
    });
  }

  /**
   * A leave request counts only working days, worked out when it was made. When a holiday is added (or removed) inside a
   * waiting or approved request, its days are counted again, and an approved paid leave gives back (or takes) the
   * difference from the person's balance, so a holiday is never spent as leave. A request left with no working day
   * at all is cancelled (its days, if approved and paid, go back to the balance).
   */
  private async recountLeave(trx: Trx, auth: AuthContext, dates: string[]): Promise<void> {
    const { rows } = await sql<{
      id: string;
      user_id: string;
      leave_type_id: string;
      from_date: string;
      to_date: string;
      days: number;
      status: string;
      is_paid: boolean;
    }>`
      SELECT r.id, r.user_id, r.leave_type_id, r.from_date::text, r.to_date::text, r.days::float8 AS days, r.status, t.is_paid
      FROM leave_requests r JOIN leave_types t ON t.id = r.leave_type_id
      WHERE r.status IN ('pending', 'approved')
        AND EXISTS (SELECT 1 FROM unnest(${dates}::date[]) d WHERE d BETWEEN r.from_date AND r.to_date)
      FOR UPDATE OF r`.execute(trx);
    for (const r of rows) {
      const { rows: off } = await sql<{ days: number[] }>`
        SELECT weekly_off_days::int[] AS days FROM attendance_settings WHERE effective_from <= ${r.from_date}::date ORDER BY effective_from DESC LIMIT 1`.execute(
        trx,
      );
      const { rows: hol } = await sql<{ d: string }>`
        SELECT holiday_date::text AS d FROM holidays WHERE holiday_date BETWEEN ${r.from_date}::date AND ${r.to_date}::date`.execute(
        trx,
      );
      const halfDay = r.from_date === r.to_date && r.days === 0.5;
      const days = countLeaveDays({
        from: r.from_date,
        to: r.to_date,
        weeklyOff: off[0]?.days ?? [0],
        holidays: new Set(hol.map((h) => h.d)),
        halfDay,
      });
      if (days === r.days) continue;
      if (r.status === 'approved' && r.is_paid) {
        await sql`
          UPDATE leave_balances SET balance = balance + ${r.days - days}
          WHERE user_id = ${r.user_id} AND leave_type_id = ${r.leave_type_id} AND year = ${Number(r.from_date.slice(0, 4))}`.execute(
          trx,
        );
      }
      if (days === 0)
        await sql`UPDATE leave_requests SET status = 'cancelled' WHERE id = ${r.id}`.execute(trx);
      else await sql`UPDATE leave_requests SET days = ${days} WHERE id = ${r.id}`.execute(trx);
      await this.audit.write(trx, {
        tenantId: auth.tenantId,
        actorId: auth.userId,
        action: 'leave.recount',
        entity: 'leave_request',
        entityId: r.id,
        before: { days: r.days, status: r.status },
        after: days === 0 ? { days: r.days, status: 'cancelled' } : { days, status: r.status },
        ip: auth.ip,
        requestId: auth.requestId,
      });
    }
  }

  private record(
    trx: Parameters<AuditService['write']>[0],
    auth: AuthContext,
    action: string,
    id: string,
    before: unknown,
    after: unknown,
  ) {
    return this.audit.write(trx, {
      tenantId: auth.tenantId,
      actorId: auth.userId,
      action,
      entity: 'holiday',
      entityId: id,
      before,
      after,
      ip: auth.ip,
      requestId: auth.requestId,
    });
  }
}
