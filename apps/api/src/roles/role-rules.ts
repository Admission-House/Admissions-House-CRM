import { AppError } from '../common/app-error.js';

/**
 * Nobody can hand out more than they hold. Without this, anyone allowed to edit roles or users
 * could give themselves, or a friend, every permission in the system.
 */
export function assertCanGrant(held: ReadonlySet<string>, wanted: readonly string[]): void {
  const missing = wanted.filter((code) => !held.has(code));
  if (missing.length > 0) {
    throw new AppError(
      'PERMISSION_ESCALATION',
      `You cannot grant permissions you do not have: ${missing.join(', ')}`,
      403,
    );
  }
}

export interface RoleShape {
  systemKey: string | null;
  isSystem: boolean;
}

/** The Super Admin role always holds every permission, so its list cannot be edited. */
export function assertRoleEditable(role: RoleShape, change: { permissions?: boolean; name?: boolean; scope?: boolean }): void {
  if (role.systemKey === 'super_admin') {
    throw new AppError('ROLE_LOCKED', 'The Super Admin role cannot be changed', 409);
  }
  if (role.isSystem && (change.name || change.scope)) {
    throw new AppError('ROLE_LOCKED', 'The name and visibility of a standard role cannot be changed', 409);
  }
}

const SCOPE_RANK = { own: 1, team: 2, all: 3 } as const;
export type ScopeName = keyof typeof SCOPE_RANK;

/** A role cannot see more people than the person creating it can. */
export function assertScopeNotWider(actor: ScopeName, wanted: ScopeName): void {
  if (SCOPE_RANK[wanted] > SCOPE_RANK[actor]) {
    throw new AppError('SCOPE_ESCALATION', 'You cannot give a role wider visibility than your own', 403);
  }
}
