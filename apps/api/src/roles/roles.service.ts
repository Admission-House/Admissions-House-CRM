import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppError } from '../common/app-error.js';
import { DatabaseService, Trx } from '../database/database.service.js';
import type { CreateRoleDto, UpdateRoleDto } from './roles.dto.js';
import { assertCanGrant, assertRoleEditable, assertScopeNotWider } from './role-rules.js';

export interface RoleSummary {
  id: string;
  name: string;
  key: string | null;
  dataScope: string;
  requiresOffice: boolean;
  isSystem: boolean;
  permissionCount: number;
  userCount: number;
}

@Injectable()
export class RolesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /** Every permission a role can hold, grouped by area, for the role editor. */
  listPermissions(auth: AuthContext) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const rows = await trx.selectFrom('permissions').select(['code', 'module', 'description']).orderBy('module').orderBy('code').execute();
      const grouped = new Map<string, { code: string; description: string }[]>();
      for (const r of rows) {
        const list = grouped.get(r.module) ?? [];
        list.push({ code: r.code, description: r.description });
        grouped.set(r.module, list);
      }
      return [...grouped].map(([module, permissions]) => ({ module, permissions }));
    });
  }

  list(auth: AuthContext): Promise<RoleSummary[]> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const { rows } = await sql<{
        id: string; name: string; system_key: string | null; data_scope: string; requires_office: boolean;
        is_system: boolean; permission_count: string; user_count: string;
      }>`
        SELECT r.id, r.name, r.system_key, r.data_scope, r.requires_office, r.is_system,
               (SELECT count(*) FROM role_permissions rp WHERE rp.role_id = r.id) AS permission_count,
               (SELECT count(*) FROM users u WHERE u.role_id = r.id) AS user_count
        FROM roles r
        ORDER BY r.is_system DESC, r.name`.execute(trx);
      return rows.map((r) => ({
        id: r.id, name: r.name, key: r.system_key, dataScope: r.data_scope, requiresOffice: r.requires_office,
        isSystem: r.is_system, permissionCount: Number(r.permission_count), userCount: Number(r.user_count),
      }));
    });
  }

  get(auth: AuthContext, id: string) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const role = await this.load(trx, id);
      return { ...role.summary, permissions: role.permissions };
    });
  }

  create(auth: AuthContext, dto: CreateRoleDto) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      assertScopeNotWider(auth.dataScope, dto.dataScope);
      // Unknown codes are reported as such before anything is said about who may grant what.
      const permissionIds = await this.permissionIds(trx, dto.permissions);
      assertCanGrant(auth.permissions, dto.permissions);
      await this.assertNameFree(trx, dto.name);

      const role = await trx
        .insertInto('roles')
        .values({ tenant_id: auth.tenantId, name: dto.name, data_scope: dto.dataScope, requires_office: dto.requiresOffice })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.setPermissions(trx, auth.tenantId, role.id, permissionIds);

      await this.audit.write(trx, {
        tenantId: auth.tenantId, actorId: auth.userId, action: 'role.create', entity: 'role', entityId: role.id,
        after: { name: dto.name, dataScope: dto.dataScope, requiresOffice: dto.requiresOffice, permissions: dto.permissions },
        ip: auth.ip, requestId: auth.requestId,
      });
      const created = await this.load(trx, role.id);
      return { ...created.summary, permissions: created.permissions };
    });
  }

  update(auth: AuthContext, id: string, dto: UpdateRoleDto) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const current = await this.load(trx, id);
      assertRoleEditable(
        { systemKey: current.summary.key, isSystem: current.summary.isSystem },
        {
          permissions: dto.permissions !== undefined,
          name: dto.name !== undefined && dto.name !== current.summary.name,
          scope: (dto.dataScope !== undefined && dto.dataScope !== current.summary.dataScope) ||
            (dto.requiresOffice !== undefined && dto.requiresOffice !== current.summary.requiresOffice),
        },
      );
      if (dto.dataScope) assertScopeNotWider(auth.dataScope, dto.dataScope);
      if (dto.name && dto.name !== current.summary.name) await this.assertNameFree(trx, dto.name);

      if (dto.permissions) {
        const ids = await this.permissionIds(trx, dto.permissions);
        // Only what is being added needs to be held by the person making the change.
        assertCanGrant(auth.permissions, dto.permissions.filter((c) => !current.permissions.includes(c)));
        await this.setPermissions(trx, auth.tenantId, id, ids);
      }
      // Changing only the permissions leaves nothing to update on the role row itself.
      const changes = {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.dataScope !== undefined && { data_scope: dto.dataScope }),
        ...(dto.requiresOffice !== undefined && { requires_office: dto.requiresOffice }),
      };
      if (Object.keys(changes).length > 0) await trx.updateTable('roles').set(changes).where('id', '=', id).execute();

      const after = await this.load(trx, id);
      await this.audit.write(trx, {
        tenantId: auth.tenantId, actorId: auth.userId, action: 'role.update', entity: 'role', entityId: id,
        before: { ...current.summary, permissions: current.permissions },
        after: { ...after.summary, permissions: after.permissions },
        ip: auth.ip, requestId: auth.requestId,
      });
      return { ...after.summary, permissions: after.permissions };
    });
  }

  remove(auth: AuthContext, id: string): Promise<void> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const role = await this.load(trx, id);
      if (role.summary.isSystem) throw new AppError('ROLE_LOCKED', 'A standard role cannot be deleted', 409);
      if (role.summary.userCount > 0) {
        throw AppError.conflict('ROLE_IN_USE', `${role.summary.userCount} people still have this role. Move them to another role first.`);
      }
      await trx.deleteFrom('roles').where('id', '=', id).execute();
      await this.audit.write(trx, {
        tenantId: auth.tenantId, actorId: auth.userId, action: 'role.delete', entity: 'role', entityId: id,
        before: { ...role.summary, permissions: role.permissions }, ip: auth.ip, requestId: auth.requestId,
      });
    });
  }

  // ---------------------------------------------------------------- helpers

  private async load(trx: Trx, id: string): Promise<{ summary: RoleSummary; permissions: string[] }> {
    const { rows } = await sql<{
      id: string; name: string; system_key: string | null; data_scope: string; requires_office: boolean;
      is_system: boolean; user_count: string; permissions: string[];
    }>`
      SELECT r.id, r.name, r.system_key, r.data_scope, r.requires_office, r.is_system,
             (SELECT count(*) FROM users u WHERE u.role_id = r.id) AS user_count,
             COALESCE((SELECT array_agg(p.code ORDER BY p.code) FROM role_permissions rp
                       JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = r.id), '{}') AS permissions
      FROM roles r WHERE r.id = ${id}`.execute(trx);
    const r = rows[0];
    if (!r) throw AppError.notFound('Role');
    return {
      permissions: r.permissions,
      summary: {
        id: r.id, name: r.name, key: r.system_key, dataScope: r.data_scope, requiresOffice: r.requires_office,
        isSystem: r.is_system, permissionCount: r.permissions.length, userCount: Number(r.user_count),
      },
    };
  }

  private async assertNameFree(trx: Trx, name: string): Promise<void> {
    const taken = await trx.selectFrom('roles').select('id').where(sql`lower(name)`, '=', name.toLowerCase()).executeTakeFirst();
    if (taken) throw AppError.conflict('ROLE_NAME_TAKEN', 'A role with this name already exists');
  }

  private async permissionIds(trx: Trx, codes: string[]): Promise<string[]> {
    if (codes.length === 0) return [];
    const rows = await trx.selectFrom('permissions').select(['id', 'code']).where('code', 'in', codes).execute();
    const unknown = codes.filter((c) => !rows.some((r) => r.code === c));
    if (unknown.length > 0) {
      throw AppError.badRequest('UNKNOWN_PERMISSION', `Unknown permission: ${unknown.join(', ')}`, [
        { field: 'permissions', message: `Unknown permission: ${unknown.join(', ')}` },
      ]);
    }
    return rows.map((r) => r.id);
  }

  private async setPermissions(trx: Trx, tenantId: string, roleId: string, permissionIds: string[]): Promise<void> {
    await trx.deleteFrom('role_permissions').where('role_id', '=', roleId).execute();
    if (permissionIds.length > 0) {
      await trx
        .insertInto('role_permissions')
        .values(permissionIds.map((permission_id) => ({ tenant_id: tenantId, role_id: roleId, permission_id })))
        .execute();
    }
  }
}
