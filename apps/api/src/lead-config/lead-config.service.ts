import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppError } from '../common/app-error.js';
import { DatabaseService, Trx } from '../database/database.service.js';
import type { CreateRuleDto, CreateSourceDto, PolicyDto, UpdateRuleDto, UpdateSourceDto } from './lead-config.dto.js';
import { DEFAULT_DOWNLOAD_FORMS } from '../intake/intake-rules.js';

export interface SourceView {
  id: string;
  name: string;
  channelType: string;
  isActive: boolean;
}

export interface RuleView {
  id: string;
  name: string;
  priority: number;
  sourceId: string | null;
  courseId: string | null;
  locationId: string | null;
  studyMode: string | null;
  strategy: string;
  isActive: boolean;
  users: { id: string; name: string }[];
}

@Injectable()
export class LeadConfigService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- sources

  listSources(auth: AuthContext, includeInactive: boolean): Promise<SourceView[]> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      let qb = trx.selectFrom('lead_sources').select(['id', 'name', 'channel_type', 'is_active']).orderBy('name');
      if (!includeInactive) qb = qb.where('is_active', '=', true);
      return (await qb.execute()).map(toSource);
    });
  }

  createSource(auth: AuthContext, dto: CreateSourceDto): Promise<SourceView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      await this.assertSourceNameFree(trx, dto.name);
      const row = await trx
        .insertInto('lead_sources')
        .values({ tenant_id: auth.tenantId, name: dto.name, channel_type: dto.channelType })
        .returning(['id', 'name', 'channel_type', 'is_active'])
        .executeTakeFirstOrThrow();
      await this.record(trx, auth, 'lead_source.create', 'lead_source', row.id, undefined, dto);
      return toSource(row);
    });
  }

  updateSource(auth: AuthContext, id: string, dto: UpdateSourceDto): Promise<SourceView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const before = await trx.selectFrom('lead_sources').select(['id', 'name', 'channel_type', 'is_active']).where('id', '=', id).executeTakeFirst();
      if (!before) throw AppError.notFound('Lead source');
      if (dto.name && dto.name.toLowerCase() !== before.name.toLowerCase()) await this.assertSourceNameFree(trx, dto.name);
      const after = await trx
        .updateTable('lead_sources')
        .set({
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.channelType !== undefined && { channel_type: dto.channelType }),
          ...(dto.isActive !== undefined && { is_active: dto.isActive }),
        })
        .where('id', '=', id)
        .returning(['id', 'name', 'channel_type', 'is_active'])
        .executeTakeFirstOrThrow();
      await this.record(trx, auth, 'lead_source.update', 'lead_source', id, toSource(before), toSource(after));
      return toSource(after);
    });
  }

  // ------------------------------------------------------------------ rules

  listRules(auth: AuthContext): Promise<RuleView[]> {
    return this.db.withTenant(auth.tenantId, (trx) => this.loadRules(trx));
  }

  createRule(auth: AuthContext, dto: CreateRuleDto): Promise<RuleView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      await this.assertPriorityFree(trx, dto.priority);
      await this.assertUsersUsable(trx, dto.userIds);
      await this.assertConditionsExist(trx, dto);
      const row = await trx
        .insertInto('assignment_rules')
        .values({
          tenant_id: auth.tenantId, name: dto.name, priority: dto.priority, source_id: dto.sourceId, course_id: dto.courseId,
          location_id: dto.locationId, study_mode: dto.studyMode, strategy: dto.strategy, is_active: dto.isActive,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.setUsers(trx, auth.tenantId, row.id, dto.userIds);
      const created = (await this.loadRules(trx, row.id))[0]!;
      await this.record(trx, auth, 'assignment_rule.create', 'assignment_rule', row.id, undefined, created);
      return created;
    });
  }

  updateRule(auth: AuthContext, id: string, dto: UpdateRuleDto): Promise<RuleView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const before = (await this.loadRules(trx, id))[0];
      if (!before) throw AppError.notFound('Assignment rule');
      if (dto.priority !== undefined && dto.priority !== before.priority) await this.assertPriorityFree(trx, dto.priority);
      if (dto.userIds) await this.assertUsersUsable(trx, dto.userIds);
      await this.assertConditionsExist(trx, dto);

      // Changing only the people leaves nothing to update on the rule itself.
      const changes = {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.priority !== undefined && { priority: dto.priority }),
        ...(dto.sourceId !== undefined && { source_id: dto.sourceId }),
        ...(dto.courseId !== undefined && { course_id: dto.courseId }),
        ...(dto.locationId !== undefined && { location_id: dto.locationId }),
        ...(dto.studyMode !== undefined && { study_mode: dto.studyMode }),
        ...(dto.strategy !== undefined && { strategy: dto.strategy }),
        ...(dto.isActive !== undefined && { is_active: dto.isActive }),
      };
      if (Object.keys(changes).length > 0) await trx.updateTable('assignment_rules').set(changes).where('id', '=', id).execute();
      if (dto.userIds) await this.setUsers(trx, auth.tenantId, id, dto.userIds);
      const after = (await this.loadRules(trx, id))[0]!;
      await this.record(trx, auth, 'assignment_rule.update', 'assignment_rule', id, before, after);
      return after;
    });
  }

  removeRule(auth: AuthContext, id: string): Promise<void> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const before = (await this.loadRules(trx, id))[0];
      if (!before) throw AppError.notFound('Assignment rule');
      await trx.deleteFrom('assignment_rules').where('id', '=', id).execute();
      await this.record(trx, auth, 'assignment_rule.delete', 'assignment_rule', id, before, undefined);
    });
  }

  // ----------------------------------------------------------------- policy

  getPolicy(auth: AuthContext) {
    return this.db.withTenant(auth.tenantId, (trx) => this.loadPolicy(trx));
  }

  setPolicy(auth: AuthContext, dto: PolicyDto) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const before = await this.loadPolicy(trx);
      await trx
        .insertInto('lead_policies')
        .values({ tenant_id: auth.tenantId, duplicate_action: dto.duplicateAction, auto_assign: dto.autoAssign, ...(dto.downloadForms && { download_forms: dto.downloadForms }) })
        .onConflict((oc) => oc.column('tenant_id').doUpdateSet({ duplicate_action: dto.duplicateAction, auto_assign: dto.autoAssign, ...(dto.downloadForms && { download_forms: dto.downloadForms }), updated_at: sql`now()` }))
        .execute();
      await this.record(trx, auth, 'lead_policy.update', 'lead_policy', auth.tenantId, before, dto);
      return this.loadPolicy(trx);
    });
  }

  // ---------------------------------------------------------------- helpers

  private async loadPolicy(trx: Trx) {
    const row = await trx.selectFrom('lead_policies').select(['duplicate_action', 'auto_assign', 'download_forms']).executeTakeFirst();
    return { duplicateAction: row?.duplicate_action ?? 'attach', autoAssign: row?.auto_assign ?? true, downloadForms: row?.download_forms ?? DEFAULT_DOWNLOAD_FORMS };
  }

  private async loadRules(trx: Trx, id?: string): Promise<RuleView[]> {
    const { rows } = await sql<{
      id: string; name: string; priority: number; source_id: string | null; course_id: string | null; location_id: string | null;
      study_mode: string | null; strategy: string; is_active: boolean; users: { id: string; name: string }[];
    }>`
      SELECT r.id, r.name, r.priority, r.source_id, r.course_id, r.location_id, r.study_mode, r.strategy, r.is_active,
             COALESCE(jsonb_agg(jsonb_build_object('id', u.id, 'name', u.name) ORDER BY u.name) FILTER (WHERE u.id IS NOT NULL), '[]'::jsonb) AS users
      FROM assignment_rules r
      LEFT JOIN assignment_rule_users ru ON ru.rule_id = r.id
      LEFT JOIN users u ON u.id = ru.user_id
      WHERE ${id ? sql`r.id = ${id}` : sql`true`}
      GROUP BY r.id
      ORDER BY r.priority`.execute(trx);
    return rows.map((r) => ({
      id: r.id, name: r.name, priority: r.priority, sourceId: r.source_id, courseId: r.course_id, locationId: r.location_id,
      studyMode: r.study_mode, strategy: r.strategy, isActive: r.is_active, users: r.users,
    }));
  }

  private async setUsers(trx: Trx, tenantId: string, ruleId: string, userIds: string[]): Promise<void> {
    await trx.deleteFrom('assignment_rule_users').where('rule_id', '=', ruleId).execute();
    if (userIds.length > 0) {
      await trx.insertInto('assignment_rule_users').values(userIds.map((user_id) => ({ tenant_id: tenantId, rule_id: ruleId, user_id }))).execute();
    }
  }

  private async assertUsersUsable(trx: Trx, userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    const found = await trx.selectFrom('users').select('id').where('id', 'in', userIds).where('status', '=', 'active').execute();
    const missing = userIds.filter((id) => !found.some((f) => f.id === id));
    if (missing.length > 0) {
      throw AppError.badRequest('USER_INVALID', 'Some of the chosen people do not exist or are not active', [{ field: 'userIds', message: `Not usable: ${missing.join(', ')}` }]);
    }
  }

  /** The source, course and place a rule refers to must exist (foreign keys would say so less kindly). */
  private async assertConditionsExist(trx: Trx, dto: { sourceId?: string | null; courseId?: string | null; locationId?: string | null }): Promise<void> {
    const checks: [string | null | undefined, 'lead_sources' | 'courses' | 'locations', string][] = [
      [dto.sourceId, 'lead_sources', 'sourceId'],
      [dto.courseId, 'courses', 'courseId'],
      [dto.locationId, 'locations', 'locationId'],
    ];
    for (const [id, table, field] of checks) {
      if (!id) continue;
      const found = await trx.selectFrom(table).select('id').where('id', '=', id).executeTakeFirst();
      if (!found) throw AppError.badRequest('CONDITION_INVALID', `That ${field.replace('Id', '')} does not exist`, [{ field, message: 'Choose an existing one' }]);
    }
  }

  private async assertPriorityFree(trx: Trx, priority: number): Promise<void> {
    const taken = await trx.selectFrom('assignment_rules').select('id').where('priority', '=', priority).executeTakeFirst();
    if (taken) throw AppError.conflict('PRIORITY_TAKEN', `Another rule already has priority ${priority}`);
  }

  private async assertSourceNameFree(trx: Trx, name: string): Promise<void> {
    const taken = await trx.selectFrom('lead_sources').select('id').where(sql`lower(name)`, '=', name.toLowerCase()).executeTakeFirst();
    if (taken) throw AppError.conflict('SOURCE_EXISTS', 'A lead source with this name already exists');
  }

  private record(trx: Trx, auth: AuthContext, action: string, entity: string, id: string, before: unknown, after: unknown) {
    return this.audit.write(trx, { tenantId: auth.tenantId, actorId: auth.userId, action, entity, entityId: id, before, after, ip: auth.ip, requestId: auth.requestId });
  }
}

function toSource(r: { id: string; name: string; channel_type: string; is_active: boolean }): SourceView {
  return { id: r.id, name: r.name, channelType: r.channel_type, isActive: r.is_active };
}
