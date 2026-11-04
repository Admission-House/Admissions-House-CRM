import type { RoleKey } from './auth-context.js';

/**
 * Who a company requires to use two-step sign-in. "none" leaves it to each person. The roles are the
 * three standard ones; a role a company made for itself is not named here, so it is not covered.
 */
export const TWO_STEP_POLICIES = ['none', 'super_admin', 'admins'] as const;
export type TwoStepPolicy = (typeof TWO_STEP_POLICIES)[number];

/** What is stored may be missing or from an older version: anything unknown means nobody is required. */
export const parseTwoStepPolicy = (value: unknown): TwoStepPolicy =>
  (TWO_STEP_POLICIES as readonly unknown[]).includes(value) ? (value as TwoStepPolicy) : 'none';

/** Whether a person in this role must have two-step sign-in on. */
export function twoStepRequired(policy: TwoStepPolicy, roleKey: RoleKey | null): boolean {
  if (policy === 'super_admin') return roleKey === 'super_admin';
  if (policy === 'admins') return roleKey === 'super_admin' || roleKey === 'admin';
  return false;
}
