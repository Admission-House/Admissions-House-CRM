import { Injectable } from '@nestjs/common';
import { sql, SqlBool } from 'kysely';
import { z } from 'zod';
import { scopeCondition } from '../access/scope.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AuthRepository } from '../auth/auth.repository.js';
import { AppError } from '../common/app-error.js';
import { decodeCursor, Page, toPage } from '../common/pagination.js';
import { DatabaseService, Trx } from '../database/database.service.js';

export interface DeviceView {
  id: string;
  user: { id: string; name: string };
  platform: string;
  label: string | null;
  /** The last characters only, enough to tell two phones apart. */
  fingerprintTail: string;
  status: 'pending' | 'approved';
  approvedBy: string | null;
  approvedAt: Date | null;
  firstSeenAt: Date;
}

interface Row {
  id: string;
  user_id: string;
  user_name: string;
  platform: string;
  label: string | null;
  device_fingerprint: string;
  approved_at: Date | null;
  approver_name: string | null;
  created_at: Date;
}

const cursorShape = z.object({ t: z.string(), i: z.string() });

@Injectable()
export class DevicesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly authRepo: AuthRepository,
  ) {}

  list(auth: AuthContext, query: { status: 'pending' | 'approved' | 'all'; limit: number; cursor?: string }): Promise<Page<DeviceView>> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const after = decodeCursor(query.cursor, cursorShape);
      let qb = this.baseQuery(trx).select(sql<string>`d.created_at::text`.as('created_text'));
      const scoped = scopeCondition(auth, 'd.user_id');
      if (scoped) qb = qb.where(scoped);
      if (query.status === 'pending') qb = qb.where('d.approved_at', 'is', null);
      if (query.status === 'approved') qb = qb.where('d.approved_at', 'is not', null);
      if (after) qb = qb.where(sql<SqlBool>`(d.created_at, d.id) < (${after.t}::timestamptz, ${after.i}::uuid)`);

      const rows = await qb.orderBy('d.created_at', 'desc').orderBy('d.id', 'desc').limit(query.limit + 1).execute();
      const page = toPage(rows, query.limit, (last) => ({ t: last.created_text, i: last.id }));
      return { items: page.items.map(toView), nextCursor: page.nextCursor };
    });
  }

  approve(auth: AuthContext, id: string): Promise<DeviceView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const device = await this.loadScoped(trx, auth, id);
      // The person a phone belongs to cannot be the one who vouches for it.
      if (device.user_id === auth.userId) {
        throw new AppError('SELF_APPROVAL', 'Another person must approve your own phone', 403);
      }
      if (device.approved_at === null) {
        await trx.updateTable('user_devices').set({ approved_by: auth.userId, approved_at: sql`now()` }).where('id', '=', id).execute();
        await this.audit.write(trx, {
          tenantId: auth.tenantId, actorId: auth.userId, action: 'device.approve', entity: 'device', entityId: id,
          after: { userId: device.user_id, platform: device.platform, label: device.label },
          ip: auth.ip, requestId: auth.requestId,
        });
      }
      return toView(await this.loadScoped(trx, auth, id));
    });
  }

  /** Withdraws approval and signs the phone out. The owner has to ask for approval again. */
  revoke(auth: AuthContext, id: string): Promise<DeviceView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const device = await this.loadScoped(trx, auth, id);
      await trx.updateTable('user_devices').set({ approved_by: null, approved_at: null }).where('id', '=', id).execute();
      const { numAffectedRows } = await sql`
        UPDATE user_sessions SET ended_at = now(), ended_reason = 'revoked'
        WHERE device_id = ${id} AND ended_at IS NULL`.execute(trx);
      await this.audit.write(trx, {
        tenantId: auth.tenantId, actorId: auth.userId, action: 'device.revoke', entity: 'device', entityId: id,
        after: { userId: device.user_id, sessionsEnded: Number(numAffectedRows ?? 0) }, ip: auth.ip, requestId: auth.requestId,
      });
      return toView(await this.loadScoped(trx, auth, id));
    });
  }

  // ---------------------------------------------------------------- helpers

  private baseQuery(trx: Trx) {
    return trx
      .selectFrom('user_devices as d')
      .innerJoin('users as u', 'u.id', 'd.user_id')
      .leftJoin('users as a', 'a.id', 'd.approved_by')
      .select([
        'd.id', 'd.user_id', 'u.name as user_name', 'd.platform', 'd.label', 'd.device_fingerprint',
        'd.approved_at', 'a.name as approver_name', 'd.created_at',
      ]);
  }

  /** A device of someone the caller may see, or a 404. */
  private async loadScoped(trx: Trx, auth: AuthContext, id: string): Promise<Row> {
    let qb = this.baseQuery(trx).where('d.id', '=', id);
    const scoped = scopeCondition(auth, 'd.user_id');
    if (scoped) qb = qb.where(scoped);
    const row = await qb.executeTakeFirst();
    if (!row) throw AppError.notFound('Device');
    return row;
  }
}

function toView(r: Row): DeviceView {
  return {
    id: r.id,
    user: { id: r.user_id, name: r.user_name },
    platform: r.platform,
    label: r.label,
    fingerprintTail: r.device_fingerprint.slice(-6),
    status: r.approved_at ? 'approved' : 'pending',
    approvedBy: r.approver_name,
    approvedAt: r.approved_at,
    firstSeenAt: r.created_at,
  };
}
