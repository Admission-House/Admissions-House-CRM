import { Injectable } from '@nestjs/common';
import { sql, SqlBool } from 'kysely';
import { scopeCondition } from '../access/scope.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AuthRepository } from '../auth/auth.repository.js';
import { PasswordService } from '../auth/password.service.js';
import { AppError } from '../common/app-error.js';
import { decodeCursor, Page, toPage } from '../common/pagination.js';
import { DatabaseService, Trx } from '../database/database.service.js';
import { z } from 'zod';
import { assertCanGrant } from '../roles/role-rules.js';
import {
  assertCanManage,
  assertManagerWithinScope,
  assertNotLastSuperAdmin,
  assertPlacement,
} from './user-rules.js';
import type { CreateUserDto, ListUsersDto, UpdateUserDto } from './users.dto.js';

export interface UserView {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  status: string;
  designation: string | null;
  joinedOn: string | null;
  lastLoginAt: Date | null;
  mustChangePassword: boolean;
  createdAt: Date;
  role: { id: string; name: string; key: string | null };
  branch: { id: string; name: string } | null;
  manager: { id: string; name: string } | null;
}

interface RoleInfo {
  id: string;
  name: string;
  system_key: string | null;
  requires_office: boolean;
  permissions: string[];
}

const cursorShape = z.object({ n: z.string(), i: z.string() });

@Injectable()
export class UsersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly authRepo: AuthRepository,
    private readonly passwords: PasswordService,
  ) {}

  // ------------------------------------------------------------------ reads

  list(auth: AuthContext, query: ListUsersDto): Promise<Page<UserView>> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const after = decodeCursor(query.cursor, cursorShape);
      let qb = this.baseQuery(trx).select(sql<string>`lower(u.name)`.as('sort_key'));

      const scoped = scopeCondition(auth, 'u.id');
      if (scoped) qb = qb.where(scoped);
      if (query.status) qb = qb.where('u.status', '=', query.status);
      if (query.roleId) qb = qb.where('u.role_id', '=', query.roleId);
      if (query.branchId) qb = qb.where('u.branch_id', '=', query.branchId);
      if (query.managerId) qb = qb.where('u.manager_id', '=', query.managerId);
      if (query.q) {
        const like = `%${query.q.replace(/[\\%_]/g, '\\$&')}%`;
        qb = qb.where((eb) => eb.or([eb('u.name', 'ilike', like), eb('u.email', 'ilike', like), eb('u.phone', 'like', like)]));
      }
      if (after) qb = qb.where(sql<SqlBool>`(lower(u.name), u.id) > (${after.n}, ${after.i}::uuid)`);

      const rows = await qb.orderBy(sql`lower(u.name)`).orderBy('u.id').limit(query.limit + 1).execute();
      const page = toPage(rows, query.limit, (last) => ({ n: last.sort_key, i: last.id }));
      return { items: page.items.map(toView), nextCursor: page.nextCursor };
    });
  }

  get(auth: AuthContext, id: string): Promise<UserView> {
    return this.db.withTenant(auth.tenantId, async (trx) => toView(await this.loadScoped(trx, auth, id)));
  }

  // ----------------------------------------------------------------- writes

  async create(auth: AuthContext, dto: CreateUserDto): Promise<{ user: UserView; temporaryPassword: string }> {
    const temporaryPassword = this.passwords.generateTemporary();
    const passwordHash = await this.passwords.hash(temporaryPassword);

    const user = await this.db.withTenant(auth.tenantId, async (trx) => {
      const role = await this.requireRole(trx, dto.roleId);
      assertCanGrant(auth.permissions, role.permissions);

      const branchId = dto.branchId ?? null;
      const managerId = dto.managerId ?? null;
      if (branchId) await this.requireBranch(trx, branchId);
      const manager = managerId ? await this.requireManager(trx, managerId) : null;
      assertPlacement({
        role: { systemKey: role.system_key, requiresOffice: role.requires_office, name: role.name },
        branchId, managerId, managerRoleKey: manager?.system_key,
      });
      assertManagerWithinScope(auth, managerId);

      const taken = await trx.selectFrom('users').select('id').where('email', '=', dto.email).executeTakeFirst();
      if (taken) throw AppError.conflict('EMAIL_TAKEN', 'Someone already has this email address');

      const created = await trx
        .insertInto('users')
        .values({
          tenant_id: auth.tenantId,
          role_id: role.id,
          branch_id: branchId,
          manager_id: managerId,
          name: dto.name,
          email: dto.email,
          phone: dto.phone ?? null,
          password_hash: passwordHash,
          joined_on: dto.joinedOn ?? null,
          must_change_password: true,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      await trx.insertInto('user_profiles').values({ tenant_id: auth.tenantId, user_id: created.id, designation: dto.designation ?? null }).execute();
      // Leave balances for the current year, one per leave type.
      await sql`
        INSERT INTO leave_balances (tenant_id, user_id, leave_type_id, year, balance)
        SELECT lt.tenant_id, ${created.id}, lt.id,
               EXTRACT(YEAR FROM now() AT TIME ZONE (SELECT timezone FROM tenants))::int, lt.yearly_quota
        FROM leave_types lt`.execute(trx);

      await this.audit.write(trx, {
        tenantId: auth.tenantId, actorId: auth.userId, action: 'user.create', entity: 'user', entityId: created.id,
        after: { name: dto.name, email: dto.email, roleId: role.id, branchId, managerId },
        ip: auth.ip, requestId: auth.requestId,
      });
      return toView(await this.loadScoped(trx, auth, created.id));
    });
    return { user, temporaryPassword };
  }

  update(auth: AuthContext, id: string, dto: UpdateUserDto): Promise<UserView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const target = await this.loadScoped(trx, auth, id);
      const targetRole = (await this.requireRole(trx, target.role_id));
      assertCanManage(auth.permissions, targetRole.permissions);

      if (id === auth.userId && (dto.roleId !== undefined || dto.status !== undefined || dto.managerId !== undefined || dto.branchId !== undefined)) {
        throw new AppError('SELF_CHANGE_NOT_ALLOWED', 'You cannot change your own role, office, manager or status', 403);
      }

      const role = dto.roleId && dto.roleId !== target.role_id ? await this.requireRole(trx, dto.roleId) : targetRole;
      if (role.id !== targetRole.id) assertCanGrant(auth.permissions, role.permissions);

      const branchId = dto.branchId !== undefined ? dto.branchId : target.branch_id;
      const managerId = dto.managerId !== undefined ? dto.managerId : target.manager_id;
      if (dto.branchId) await this.requireBranch(trx, dto.branchId);
      const manager = managerId ? await this.requireManager(trx, managerId) : null;
      assertPlacement({
        role: { systemKey: role.system_key, requiresOffice: role.requires_office, name: role.name },
        branchId, managerId, managerRoleKey: manager?.system_key, userId: id,
      });
      if (dto.managerId !== undefined) assertManagerWithinScope(auth, managerId);

      const status = dto.status ?? target.status;
      const wasActive = target.status === 'active';
      if (wasActive && targetRole.system_key === 'super_admin' && (status === 'inactive' || role.system_key !== 'super_admin')) {
        assertNotLastSuperAdmin(await this.countOtherActiveSuperAdmins(trx, id));
      }
      if (wasActive && targetRole.system_key === 'admin' && (status === 'inactive' || role.system_key !== 'admin')) {
        const reports = await this.countActiveReports(trx, id);
        if (reports > 0) {
          throw AppError.conflict('HAS_ACTIVE_TEAM', `${reports} active people report to this Admin. Move them to another Admin first.`);
        }
      }

      await trx
        .updateTable('users')
        .set({
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.phone !== undefined && { phone: dto.phone }),
          ...(dto.joinedOn !== undefined && { joined_on: dto.joinedOn }),
          ...(dto.status !== undefined && { status: dto.status }),
          role_id: role.id,
          branch_id: branchId,
          manager_id: managerId,
        })
        .where('id', '=', id)
        .execute();
      if (dto.designation !== undefined) {
        await trx
          .insertInto('user_profiles')
          .values({ tenant_id: auth.tenantId, user_id: id, designation: dto.designation })
          .onConflict((oc) => oc.column('user_id').doUpdateSet({ designation: dto.designation }))
          .execute();
      }
      if (wasActive && status === 'inactive') await this.authRepo.endAllSessions(trx, id, 'revoked');

      const updated = await this.loadScoped(trx, auth, id);
      await this.audit.write(trx, {
        tenantId: auth.tenantId, actorId: auth.userId, action: 'user.update', entity: 'user', entityId: id,
        before: auditShape(target), after: auditShape(updated), ip: auth.ip, requestId: auth.requestId,
      });
      return toView(updated);
    });
  }

  /** Gives the person a new one-time password and signs them out everywhere. */
  async resetPassword(auth: AuthContext, id: string): Promise<{ temporaryPassword: string }> {
    if (id === auth.userId) {
      throw AppError.badRequest('USE_CHANGE_PASSWORD', 'Use "change password" for your own account');
    }
    const temporaryPassword = this.passwords.generateTemporary();
    const passwordHash = await this.passwords.hash(temporaryPassword);

    await this.db.withTenant(auth.tenantId, async (trx) => {
      const target = await this.loadScoped(trx, auth, id);
      assertCanManage(auth.permissions, (await this.requireRole(trx, target.role_id)).permissions);

      await trx
        .updateTable('users')
        .set({ password_hash: passwordHash, must_change_password: true, failed_logins: 0, locked_until: null, password_changed_at: sql`now()` })
        .where('id', '=', id)
        .execute();
      const ended = await this.authRepo.endAllSessions(trx, id, 'revoked');
      await this.audit.write(trx, {
        tenantId: auth.tenantId, actorId: auth.userId, action: 'user.password_reset', entity: 'user', entityId: id,
        after: { sessionsEnded: ended }, ip: auth.ip, requestId: auth.requestId,
      });
    });
    return { temporaryPassword };
  }

  // ---------------------------------------------------------------- helpers

  private baseQuery(trx: Trx) {
    return trx
      .selectFrom('users as u')
      .innerJoin('roles as r', 'r.id', 'u.role_id')
      .leftJoin('branches as b', 'b.id', 'u.branch_id')
      .leftJoin('users as m', 'm.id', 'u.manager_id')
      .leftJoin('user_profiles as p', 'p.user_id', 'u.id')
      .select([
        'u.id', 'u.name', 'u.email', 'u.phone', 'u.status', 'u.joined_on', 'u.last_login_at',
        'u.must_change_password', 'u.created_at', 'u.role_id', 'u.branch_id', 'u.manager_id', 'p.designation',
        'r.name as role_name', 'r.system_key as role_key', 'b.name as branch_name', 'm.name as manager_name',
      ]);
  }

  /** A person the caller is allowed to see, or a 404. A 404 (not a 403) hides that they exist. */
  private async loadScoped(trx: Trx, auth: AuthContext, id: string): Promise<Row> {
    let qb = this.baseQuery(trx).where('u.id', '=', id);
    const scoped = scopeCondition(auth, 'u.id');
    if (scoped) qb = qb.where(scoped);
    const row = await qb.executeTakeFirst();
    if (!row) throw AppError.notFound('Person');
    return row;
  }

  private async requireRole(trx: Trx, roleId: string): Promise<RoleInfo> {
    const { rows } = await sql<RoleInfo>`
      SELECT r.id, r.name, r.system_key, r.requires_office,
             COALESCE((SELECT array_agg(p.code) FROM role_permissions rp
                       JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = r.id), '{}') AS permissions
      FROM roles r WHERE r.id = ${roleId}`.execute(trx);
    const role = rows[0];
    if (!role) throw AppError.badRequest('ROLE_NOT_FOUND', 'That role does not exist', [{ field: 'roleId', message: 'That role does not exist' }]);
    return role;
  }

  private async requireBranch(trx: Trx, branchId: string): Promise<void> {
    const branch = await trx.selectFrom('branches').select('id').where('id', '=', branchId).where('is_active', '=', true).executeTakeFirst();
    if (!branch) throw AppError.badRequest('BRANCH_NOT_FOUND', 'That office does not exist or is closed', [{ field: 'branchId', message: 'Choose an active office' }]);
  }

  private async requireManager(trx: Trx, managerId: string): Promise<{ id: string; system_key: string | null }> {
    const manager = await trx
      .selectFrom('users as u')
      .innerJoin('roles as r', 'r.id', 'u.role_id')
      .select(['u.id', 'r.system_key'])
      .where('u.id', '=', managerId)
      .where('u.status', '=', 'active')
      .executeTakeFirst();
    if (!manager) throw AppError.badRequest('MANAGER_INVALID', 'That manager does not exist or is not active', [{ field: 'managerId', message: 'Choose an active manager' }]);
    return manager;
  }

  private async countOtherActiveSuperAdmins(trx: Trx, excludingId: string): Promise<number> {
    const row = await trx
      .selectFrom('users as u')
      .innerJoin('roles as r', 'r.id', 'u.role_id')
      .select(sql<string>`count(*)`.as('n'))
      .where('r.system_key', '=', 'super_admin')
      .where('u.status', '=', 'active')
      .where('u.id', '!=', excludingId)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  private async countActiveReports(trx: Trx, managerId: string): Promise<number> {
    const row = await trx
      .selectFrom('users')
      .select(sql<string>`count(*)`.as('n'))
      .where('manager_id', '=', managerId)
      .where('status', '=', 'active')
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }
}

// ------------------------------------------------------------------ mapping

interface Row {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  status: string;
  joined_on: string | null;
  last_login_at: Date | null;
  must_change_password: boolean;
  created_at: Date;
  role_id: string;
  branch_id: string | null;
  manager_id: string | null;
  designation: string | null;
  role_name: string;
  role_key: string | null;
  branch_name: string | null;
  manager_name: string | null;
}

function toView(r: Row): UserView {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    status: r.status,
    designation: r.designation,
    joinedOn: r.joined_on,
    lastLoginAt: r.last_login_at,
    mustChangePassword: r.must_change_password,
    createdAt: r.created_at,
    role: { id: r.role_id, name: r.role_name, key: r.role_key },
    branch: r.branch_id ? { id: r.branch_id, name: r.branch_name ?? '' } : null,
    manager: r.manager_id ? { id: r.manager_id, name: r.manager_name ?? '' } : null,
  };
}

/** What is worth keeping in the audit log about a person: never the password or tokens. */
function auditShape(r: Row) {
  return {
    name: r.name, phone: r.phone, status: r.status, roleId: r.role_id, branchId: r.branch_id,
    managerId: r.manager_id, joinedOn: r.joined_on, designation: r.designation,
  };
}
