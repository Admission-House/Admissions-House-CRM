import { Injectable } from '@nestjs/common';
import { sql, SqlBool } from 'kysely';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth-context.js';
import { AppError } from '../common/app-error.js';
import { decodeCursor, Page, toPage } from '../common/pagination.js';
import { DatabaseService } from '../database/database.service.js';

export interface AuditView {
  id: string;
  at: Date;
  actor: { id: string; name: string } | null;
  action: string;
  entity: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
}

export interface AuditQuery {
  limit: number;
  cursor?: string;
  actorId?: string;
  /** An action such as salary.update, or a group such as salary. */
  action?: string;
  entity?: string;
  entityId?: string;
  from?: string;
  to?: string;
}

interface Row {
  id: string; created_text: string; at: Date; actor_id: string | null; actor_name: string | null; action: string; entity: string;
  entity_id: string | null; before: unknown; after: unknown; ip: string | null;
}

const cursorShape = z.object({ i: z.string() });
const LIKE_ESCAPE = /[\%_]/g;

/** Reads the audit log. It is read-only here: nothing in the application changes or removes an entry. */
@Injectable()
export class AuditQueryService {
  constructor(private readonly db: DatabaseService) {}

  list(auth: AuthContext, q: AuditQuery): Promise<Page<AuditView>> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const after = decodeCursor(q.cursor, cursorShape);
      const c: ReturnType<typeof sql<SqlBool>>[] = [sql<SqlBool>`true`];
      if (q.actorId) c.push(sql<SqlBool>`a.actor_id = ${q.actorId}::uuid`);
      if (q.action) {
        // "salary" matches every salary.* action; "salary.update" matches that one.
        const like = `${q.action.replace(LIKE_ESCAPE, '\$&')}.%`;
        c.push(sql<SqlBool>`(a.action = ${q.action} OR a.action LIKE ${like})`);
      }
      if (q.entity) c.push(sql<SqlBool>`a.entity = ${q.entity}`);
      if (q.entityId) c.push(sql<SqlBool>`a.entity_id = ${q.entityId}::uuid`);
      if (q.from || q.to) {
        const { rows: tz } = await sql<{ tz: string }>`SELECT timezone AS tz FROM tenants LIMIT 1`.execute(trx);
        const zone = tz[0]?.tz ?? 'UTC';
        if (q.from) c.push(sql<SqlBool>`a.created_at >= (${q.from}::date::timestamp AT TIME ZONE ${zone})`);
        if (q.to) c.push(sql<SqlBool>`a.created_at < ((${q.to}::date + 1)::timestamp AT TIME ZONE ${zone})`);
        if (q.from && q.to && q.from > q.to) throw AppError.badRequest('RANGE_INVALID', 'The start date is after the end date', [{ field: 'from', message: 'Must not be after the end date' }]);
      }
      if (after) c.push(sql<SqlBool>`a.id < ${after.i}::bigint`);

      const { rows } = await sql<Row>`
        SELECT a.id::text AS id, a.created_at::text AS created_text, a.created_at AS at, a.actor_id, u.name AS actor_name, a.action, a.entity,
               a.entity_id, a.before, a.after, host(a.ip) AS ip
        FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
        WHERE ${sql.join(c, sql` AND `)}
        ORDER BY a.id DESC LIMIT ${q.limit + 1}`.execute(trx);

      const page = toPage(rows, q.limit, (last) => ({ i: last.id }));
      return {
        items: page.items.map((r) => ({
          id: r.id, at: r.at, actor: r.actor_id ? { id: r.actor_id, name: r.actor_name ?? 'Removed user' } : null, action: r.action, entity: r.entity,
          entityId: r.entity_id, before: r.before, after: r.after, ip: r.ip,
        })),
        nextCursor: page.nextCursor,
      };
    });
  }

  /** The kinds of action in the log, to fill a filter. */
  actions(auth: AuthContext): Promise<string[]> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const { rows } = await sql<{ action: string }>`SELECT DISTINCT action FROM audit_logs WHERE created_at > now() - interval '180 days' ORDER BY action LIMIT 500`.execute(trx);
      return rows.map((r) => r.action);
    });
  }
}
