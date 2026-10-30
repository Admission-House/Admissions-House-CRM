import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppError } from '../common/app-error.js';
import { DatabaseService, Trx } from '../database/database.service.js';
import type { CreateStatusDto, CreateSubstatusDto, UpdateStatusDto } from './leads.dto.js';

export interface StatusView {
  id: string;
  name: string;
  queue: string;
  isOpen: boolean;
  requiresFollowup: boolean;
  sortOrder: number;
  isActive: boolean;
  substatuses: { id: string; name: string; sortOrder: number }[];
}

/** The statuses a company moves its leads through, and the optional second level under each. */
@Injectable()
export class LeadStatusesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  list(auth: AuthContext, includeInactive: boolean): Promise<StatusView[]> {
    return this.db.withTenant(auth.tenantId, (trx) => this.load(trx, includeInactive));
  }

  create(auth: AuthContext, dto: CreateStatusDto): Promise<StatusView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      await this.assertNameFree(trx, dto.name);
      const next = dto.sortOrder ?? (await trx.selectFrom('lead_statuses').select(sql<number>`COALESCE(max(sort_order), -1) + 1`.as('n')).executeTakeFirstOrThrow()).n;
      const row = await trx
        .insertInto('lead_statuses')
        .values({ tenant_id: auth.tenantId, name: dto.name, queue: dto.queue, is_open: dto.isOpen, requires_followup: dto.requiresFollowup, sort_order: next })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.record(trx, auth, 'lead_status.create', row.id, undefined, dto);
      return this.one(trx, row.id);
    });
  }

  update(auth: AuthContext, id: string, dto: UpdateStatusDto): Promise<StatusView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const before = await this.one(trx, id);
      if (dto.name && dto.name.toLowerCase() !== before.name.toLowerCase()) await this.assertNameFree(trx, dto.name);

      // New leads need a place to start. The last active "fresh" status cannot be switched off or moved elsewhere.
      const leavesFresh = before.queue === 'fresh' && before.isActive && (dto.isActive === false || (dto.queue !== undefined && dto.queue !== 'fresh'));
      if (leavesFresh && (await this.countActiveFresh(trx)) <= 1) {
        throw AppError.conflict('LAST_FRESH_STATUS', 'New leads start in a "fresh" status, so at least one must stay active');
      }

      const changes = {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.queue !== undefined && { queue: dto.queue }),
        ...(dto.isOpen !== undefined && { is_open: dto.isOpen }),
        ...(dto.requiresFollowup !== undefined && { requires_followup: dto.requiresFollowup }),
        ...(dto.sortOrder !== undefined && { sort_order: dto.sortOrder }),
        ...(dto.isActive !== undefined && { is_active: dto.isActive }),
      };
      if (Object.keys(changes).length > 0) await trx.updateTable('lead_statuses').set(changes).where('id', '=', id).execute();
      const after = await this.one(trx, id);
      await this.record(trx, auth, 'lead_status.update', id, strip(before), strip(after));
      return after;
    });
  }

  createSubstatus(auth: AuthContext, statusId: string, dto: CreateSubstatusDto): Promise<StatusView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      await this.one(trx, statusId);
      const taken = await trx.selectFrom('lead_substatuses').select('id').where('status_id', '=', statusId).where(sql`lower(name)`, '=', dto.name.toLowerCase()).executeTakeFirst();
      if (taken) throw AppError.conflict('SUBSTATUS_EXISTS', 'This status already has a sub-status with this name');
      const row = await trx
        .insertInto('lead_substatuses')
        .values({ tenant_id: auth.tenantId, status_id: statusId, name: dto.name, sort_order: dto.sortOrder ?? 0 })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.record(trx, auth, 'lead_substatus.create', row.id, undefined, { statusId, ...dto });
      return this.one(trx, statusId);
    });
  }

  renameSubstatus(auth: AuthContext, id: string, name: string): Promise<StatusView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const row = await trx.selectFrom('lead_substatuses').select(['status_id', 'name']).where('id', '=', id).executeTakeFirst();
      if (!row) throw AppError.notFound('Sub-status');
      await trx.updateTable('lead_substatuses').set({ name }).where('id', '=', id).execute();
      await this.record(trx, auth, 'lead_substatus.update', id, { name: row.name }, { name });
      return this.one(trx, row.status_id);
    });
  }

  removeSubstatus(auth: AuthContext, id: string): Promise<void> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const row = await trx.selectFrom('lead_substatuses').select(['name']).where('id', '=', id).executeTakeFirst();
      if (!row) throw AppError.notFound('Sub-status');
      const used = await trx.selectFrom('leads').select('id').where('substatus_id', '=', id).limit(1).executeTakeFirst();
      if (used) throw AppError.conflict('SUBSTATUS_IN_USE', 'Leads still use this sub-status. Move them first.');
      await trx.deleteFrom('lead_substatuses').where('id', '=', id).execute();
      await this.record(trx, auth, 'lead_substatus.delete', id, { name: row.name }, undefined);
    });
  }

  // ---------------------------------------------------------------- helpers

  private async load(trx: Trx, includeInactive: boolean, onlyId?: string): Promise<StatusView[]> {
    const { rows } = await sql<{
      id: string; name: string; queue: string; is_open: boolean; requires_followup: boolean; sort_order: number; is_active: boolean;
      subs: { id: string; name: string; sortOrder: number }[];
    }>`
      SELECT s.id, s.name, s.queue, s.is_open, s.requires_followup, s.sort_order, s.is_active,
             COALESCE(jsonb_agg(jsonb_build_object('id', ss.id, 'name', ss.name, 'sortOrder', ss.sort_order) ORDER BY ss.sort_order, ss.name)
                      FILTER (WHERE ss.id IS NOT NULL), '[]'::jsonb) AS subs
      FROM lead_statuses s LEFT JOIN lead_substatuses ss ON ss.status_id = s.id
      WHERE ${onlyId ? sql`s.id = ${onlyId}` : sql`true`} ${includeInactive ? sql`` : sql`AND s.is_active`}
      GROUP BY s.id ORDER BY s.sort_order, s.name`.execute(trx);
    return rows.map((r) => ({
      id: r.id, name: r.name, queue: r.queue, isOpen: r.is_open, requiresFollowup: r.requires_followup,
      sortOrder: r.sort_order, isActive: r.is_active, substatuses: r.subs,
    }));
  }

  private async one(trx: Trx, id: string): Promise<StatusView> {
    const found = (await this.load(trx, true, id))[0];
    if (!found) throw AppError.notFound('Status');
    return found;
  }

  private async countActiveFresh(trx: Trx): Promise<number> {
    const row = await trx.selectFrom('lead_statuses').select(sql<string>`count(*)`.as('n')).where('queue', '=', 'fresh').where('is_active', '=', true).executeTakeFirstOrThrow();
    return Number(row.n);
  }

  private async assertNameFree(trx: Trx, name: string): Promise<void> {
    const taken = await trx.selectFrom('lead_statuses').select('id').where(sql`lower(name)`, '=', name.toLowerCase()).executeTakeFirst();
    if (taken) throw AppError.conflict('STATUS_EXISTS', 'A status with this name already exists');
  }

  private record(trx: Trx, auth: AuthContext, action: string, id: string, before: unknown, after: unknown) {
    return this.audit.write(trx, { tenantId: auth.tenantId, actorId: auth.userId, action, entity: 'lead_status', entityId: id, before, after, ip: auth.ip, requestId: auth.requestId });
  }
}

/** What is worth keeping in the audit log about a status: its own settings, without the sub-status list. */
function strip(s: StatusView) {
  return { id: s.id, name: s.name, queue: s.queue, isOpen: s.isOpen, requiresFollowup: s.requiresFollowup, sortOrder: s.sortOrder, isActive: s.isActive };
}
