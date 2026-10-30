import { Expression, sql, SqlBool } from 'kysely';
import type { AuthContext } from '../auth/auth-context.js';

/**
 * Limits a query to the people the signed-in user may see, following the data scope of their role:
 *
 *   all  - everyone in the company
 *   team - themselves and the people who report to them
 *   own  - only themselves
 *
 * `column` is the user-id column being filtered, such as 'u.id' or 'leads.assigned_to'. It is
 * written by the calling code, never taken from a client. A column that can be NULL (an unassigned
 * lead) never matches "team" or "own".
 *
 * Returns undefined for "all", meaning no extra condition.
 */
export function scopeCondition(
  auth: Pick<AuthContext, 'userId' | 'dataScope'>,
  column: string,
): Expression<SqlBool> | undefined {
  const col = sql.ref(column);
  switch (auth.dataScope) {
    case 'all':
      return undefined;
    case 'own':
      return sql<SqlBool>`${col} = ${auth.userId}`;
    case 'team':
      return sql<SqlBool>`(${col} = ${auth.userId}
        OR ${col} IN (SELECT id FROM users WHERE manager_id = ${auth.userId}))`;
  }
}
