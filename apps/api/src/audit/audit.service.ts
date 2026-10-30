import { Injectable } from '@nestjs/common';
import type { Trx } from '../database/database.service.js';

export interface AuditEntry {
  tenantId: string;
  actorId: string | null;
  /** For example salary.update or auth.password_changed. */
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  requestId?: string | null;
}

/**
 * Writes to the append-only audit log inside the caller's transaction, so a change and its audit
 * record are saved together or not at all.
 */
@Injectable()
export class AuditService {
  async write(trx: Trx, entry: AuditEntry): Promise<void> {
    await trx
      .insertInto('audit_logs')
      .values({
        tenant_id: entry.tenantId,
        actor_id: entry.actorId,
        action: entry.action,
        entity: entry.entity,
        entity_id: entry.entityId ?? null,
        before: entry.before === undefined ? null : JSON.stringify(entry.before),
        after: entry.after === undefined ? null : JSON.stringify(entry.after),
        ip: entry.ip ?? null,
        request_id: entry.requestId ?? null,
      })
      .execute();
  }
}
