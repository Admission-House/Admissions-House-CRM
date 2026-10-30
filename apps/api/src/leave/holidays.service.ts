import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppError } from '../common/app-error.js';
import { DatabaseService } from '../database/database.service.js';
import type { CreateHolidayDto, UpdateHolidayDto } from './leave.dto.js';

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
      const taken = await trx.selectFrom('holidays').select('id').where('holiday_date', '=', dto.date).executeTakeFirst();
      if (taken) throw AppError.conflict('HOLIDAY_EXISTS', 'There is already a holiday on that day');
      const row = await trx
        .insertInto('holidays')
        .values({ tenant_id: auth.tenantId, holiday_date: dto.date, name: dto.name })
        .returning(['id', 'holiday_date', 'name'])
        .executeTakeFirstOrThrow();
      await this.record(trx, auth, 'holiday.create', row.id, undefined, dto);
      return { id: row.id, date: row.holiday_date, name: row.name };
    });
  }

  update(auth: AuthContext, id: string, dto: UpdateHolidayDto): Promise<HolidayView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const before = await trx.selectFrom('holidays').select(['id', 'holiday_date', 'name']).where('id', '=', id).executeTakeFirst();
      if (!before) throw AppError.notFound('Holiday');
      await trx.updateTable('holidays').set({ name: dto.name }).where('id', '=', id).execute();
      await this.record(trx, auth, 'holiday.update', id, { name: before.name }, { name: dto.name });
      return { id, date: before.holiday_date, name: dto.name };
    });
  }

  remove(auth: AuthContext, id: string): Promise<void> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const removed = await trx.deleteFrom('holidays').where('id', '=', id).returning(['holiday_date', 'name']).executeTakeFirst();
      if (!removed) throw AppError.notFound('Holiday');
      await this.record(trx, auth, 'holiday.delete', id, { date: removed.holiday_date, name: removed.name }, undefined);
    });
  }

  private record(trx: Parameters<AuditService['write']>[0], auth: AuthContext, action: string, id: string, before: unknown, after: unknown) {
    return this.audit.write(trx, {
      tenantId: auth.tenantId, actorId: auth.userId, action, entity: 'holiday', entityId: id,
      before, after, ip: auth.ip, requestId: auth.requestId,
    });
  }
}
