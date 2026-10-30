import { AppError } from '../common/app-error.js';

export interface PlacementInput {
  role: { systemKey: string | null; requiresOffice: boolean; name: string };
  branchId: string | null;
  managerId: string | null;
  /** The role key of the chosen manager, if one was chosen. */
  managerRoleKey: string | null | undefined;
  userId?: string;
}

/**
 * Where a person sits in the organisation: which office, and who they report to.
 * These rules are about the shape of the company, so they live apart from the database code.
 */
export function assertPlacement(p: PlacementInput): void {
  const fields = (field: string, message: string) => [{ field, message }];

  if (p.role.requiresOffice && !p.branchId) {
    const message = `${p.role.name} must be given an office, because they sign in from there`;
    throw AppError.badRequest('BRANCH_REQUIRED', message, fields('branchId', message));
  }
  if (p.managerId && p.userId && p.managerId === p.userId) {
    const message = 'A person cannot report to themselves';
    throw AppError.badRequest('MANAGER_INVALID', message, fields('managerId', message));
  }
  if (p.role.systemKey === 'super_admin' && p.managerId) {
    const message = 'A Super Admin does not report to anyone';
    throw AppError.badRequest('MANAGER_INVALID', message, fields('managerId', message));
  }
  if (p.role.systemKey === 'counsellor') {
    if (!p.managerId) {
      const message = 'A counsellor must report to an Admin';
      throw AppError.badRequest('MANAGER_REQUIRED', message, fields('managerId', message));
    }
    if (p.managerRoleKey !== 'admin') {
      const message = 'A counsellor must report to an Admin';
      throw AppError.badRequest('MANAGER_INVALID', message, fields('managerId', message));
    }
  }
}

/** The company must always have at least one Super Admin who can sign in. */
export function assertNotLastSuperAdmin(otherActiveSuperAdmins: number): void {
  if (otherActiveSuperAdmins < 1) {
    throw AppError.conflict('LAST_SUPER_ADMIN', 'The company must keep at least one active Super Admin');
  }
}

/**
 * You can change someone only if you hold every permission their role holds. Otherwise a person
 * allowed to manage users could reset the password of, or deactivate, someone more powerful.
 */
export function assertCanManage(held: ReadonlySet<string>, targetPermissions: readonly string[]): void {
  if (targetPermissions.some((code) => !held.has(code))) {
    throw new AppError('TARGET_MORE_POWERFUL', 'This person has more access than you, so you cannot change them', 403);
  }
}

/** People who are not allowed to see the whole company can add people only to their own team. */
export function assertManagerWithinScope(
  actor: { userId: string; dataScope: 'all' | 'team' | 'own' },
  managerId: string | null,
): void {
  if (actor.dataScope !== 'all' && managerId !== actor.userId) {
    throw new AppError('OUT_OF_SCOPE', 'You can place people only in your own team', 403);
  }
}
