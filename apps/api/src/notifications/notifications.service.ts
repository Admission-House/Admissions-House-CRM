import { Injectable } from '@nestjs/common';
import { sql, SqlBool } from 'kysely';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth-context.js';
import { decodeCursor, Page, toPage } from '../common/pagination.js';
import { DatabaseService, Trx } from '../database/database.service.js';

export type NotificationType = 'followup_due' | 'assignment' | 'approval' | 'security' | 'lead_new' | 'system';

export interface NotificationView {
  id: string;
  type: string;
  payload: unknown;
  readAt: Date | null;
  createdAt: Date;
}

const cursorShape = z.object({ t: z.string(), i: z.string() });

@Injectable()
export class NotificationsService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Adds a notification for each person, inside the caller's transaction so that it exists only if
   * the thing it announces was saved. Returns how many were written.
   */
  async notify(
    trx: Trx,
    n: { tenantId: string; userIds: readonly string[]; type: NotificationType; payload: Record<string, unknown> },
  ): Promise<number> {
    const userIds = [...new Set(n.userIds)];
    if (userIds.length === 0) return 0;
    await trx
      .insertInto('notifications')
      .values(userIds.map((user_id) => ({ tenant_id: n.tenantId, user_id, type: n.type, payload: JSON.stringify(n.payload) })))
      .execute();
    return userIds.length;
  }

  /**
   * Tells every active Super Admin about a security event, except the person who caused it. A repeat of
   * the same event about the same person inside `quietMinutes` is not sent again, so one stubborn
   * login attempt does not fill the bell.
   */
  async notifySuperAdmins(
    trx: Trx,
    n: { tenantId: string; payload: { event: string; userId?: string } & Record<string, unknown>; exceptUserId?: string; quietMinutes?: number },
  ): Promise<number> {
    if (n.quietMinutes && n.payload.userId) {
      const { rows } = await sql<{ one: number }>`
        SELECT 1 AS one FROM notifications
        WHERE type = 'security' AND payload->>'event' = ${n.payload.event} AND payload->>'userId' = ${n.payload.userId}
          AND created_at > now() - make_interval(mins => ${n.quietMinutes}) LIMIT 1`.execute(trx);
      if (rows.length > 0) return 0;
    }
    const { rows: admins } = await sql<{ id: string }>`
      SELECT x.id FROM users x JOIN roles r ON r.id = x.role_id
      WHERE r.system_key = 'super_admin' AND x.status = 'active'`.execute(trx);
    return this.notify(trx, { tenantId: n.tenantId, userIds: admins.map((a) => a.id).filter((id) => id !== n.exceptUserId), type: 'security', payload: n.payload });
  }

  /** The people who may approve something for `userId`: their manager and every active Super Admin. */
  async approversOf(trx: Trx, userId: string): Promise<string[]> {
    const { rows } = await sql<{ id: string }>`
      SELECT m.id FROM users u JOIN users m ON m.id = u.manager_id AND m.status = 'active' WHERE u.id = ${userId}
      UNION
      SELECT x.id FROM users x JOIN roles r ON r.id = x.role_id
      WHERE r.system_key = 'super_admin' AND x.status = 'active'`.execute(trx);
    return rows.map((r) => r.id).filter((id) => id !== userId);
  }

  list(auth: AuthContext, query: { limit: number; cursor?: string; unreadOnly: boolean }): Promise<Page<NotificationView>> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const after = decodeCursor(query.cursor, cursorShape);
      const conditions = [sql<SqlBool>`user_id = ${auth.userId}::uuid`];
      if (query.unreadOnly) conditions.push(sql<SqlBool>`read_at IS NULL`);
      if (after) conditions.push(sql<SqlBool>`(created_at, id) < (${after.t}::timestamptz, ${after.i}::bigint)`);

      const { rows } = await sql<{ id: string; type: string; payload: unknown; read_at: Date | null; created_at: Date; created_text: string }>`
        SELECT id::text AS id, type, payload, read_at, created_at, created_at::text AS created_text
        FROM notifications
        WHERE ${sql.join(conditions, sql` AND `)}
        ORDER BY created_at DESC, id DESC
        LIMIT ${query.limit + 1}`.execute(trx);
      const page = toPage(rows, query.limit, (last) => ({ t: last.created_text, i: last.id }));
      return {
        items: page.items.map((r) => ({ id: r.id, type: r.type, payload: r.payload, readAt: r.read_at, createdAt: r.created_at })),
        nextCursor: page.nextCursor,
      };
    });
  }

  unreadCount(auth: AuthContext): Promise<{ unread: number }> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const { rows } = await sql<{ n: string }>`
        SELECT count(*) AS n FROM notifications WHERE user_id = ${auth.userId} AND read_at IS NULL`.execute(trx);
      return { unread: Number(rows[0]!.n) };
    });
  }

  /** Marks the person's own notifications as read: the ones listed, or all of them. */
  markRead(auth: AuthContext, target: { ids?: string[]; all?: boolean }): Promise<{ marked: number }> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const which = target.all ? sql`true` : sql`id = ANY(${target.ids ?? []}::bigint[])`;
      const result = await sql`
        UPDATE notifications SET read_at = now()
        WHERE user_id = ${auth.userId} AND read_at IS NULL AND ${which}`.execute(trx);
      return { marked: Number(result.numAffectedRows ?? 0) };
    });
  }
}
