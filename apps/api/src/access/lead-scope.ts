import { Expression, sql, SqlBool } from 'kysely';
import type { AuthContext } from '../auth/auth-context.js';
import { scopeCondition } from './scope.js';

/**
 * The leads a person may see. It follows their data scope (all, their team, only their own) with
 * one addition: someone who can hand out leads also sees the ones nobody has yet, otherwise an
 * Admin could never pick up a lead that arrived while nobody was in the office.
 *
 * `column` is the assigned-to column of the leads table in the query, such as 'l.assigned_to'.
 * Returns undefined when everything is visible.
 */
export function leadVisibility(
  auth: Pick<AuthContext, 'userId' | 'dataScope' | 'permissions'>,
  column = 'l.assigned_to',
): Expression<SqlBool> | undefined {
  const scoped = scopeCondition(auth, column);
  if (!scoped) return undefined;
  return auth.permissions.has('lead.assign') ? sql<SqlBool>`(${scoped} OR ${sql.ref(column)} IS NULL)` : scoped;
}
