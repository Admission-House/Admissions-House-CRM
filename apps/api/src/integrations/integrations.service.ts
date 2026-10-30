import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { sql, SqlBool } from 'kysely';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppError } from '../common/app-error.js';
import { decodeCursor, Page, toPage } from '../common/pagination.js';
import { DatabaseService } from '../database/database.service.js';
import { hashApiKey } from '../intake/api-key.guard.js';
import { IntakeService } from '../intake/intake.service.js';

export interface ApiKeyView {
  id: string;
  name: string;
  source: { id: string; name: string };
  /** The first characters, enough to tell keys apart. The key itself is never shown again. */
  prefix: string;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface EventView {
  id: string;
  source: string | null;
  externalId: string;
  status: string;
  attempts: number;
  error: string | null;
  receivedAt: Date;
  processedAt: Date | null;
}

const cursorShape = z.object({ t: z.string(), i: z.string() });

@Injectable()
export class IntegrationsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly intake: IntakeService,
  ) {}

  // --------------------------------------------------------------- API keys

  listKeys(auth: AuthContext): Promise<ApiKeyView[]> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const rows = await trx
        .selectFrom('api_keys as k')
        .innerJoin('lead_sources as s', 's.id', 'k.source_id')
        .select(['k.id', 'k.name', 'k.key_prefix', 'k.last_used_at', 'k.revoked_at', 'k.created_at', 's.id as source_id', 's.name as source_name'])
        .orderBy('k.created_at', 'desc')
        .execute();
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        source: { id: r.source_id, name: r.source_name },
        prefix: r.key_prefix,
        lastUsedAt: r.last_used_at,
        revokedAt: r.revoked_at,
        createdAt: r.created_at,
      }));
    });
  }

  /** Creates a key for one lead source. The key is returned here and never again. */
  createKey(auth: AuthContext, dto: { name: string; sourceId: string }) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const source = await trx.selectFrom('lead_sources').select(['id', 'name', 'is_active']).where('id', '=', dto.sourceId).executeTakeFirst();
      if (!source || !source.is_active) {
        throw AppError.badRequest('SOURCE_INVALID', 'Choose a lead source that is in use', [
          { field: 'sourceId', message: 'Choose a lead source that is in use' },
        ]);
      }
      const key = `ahk_${randomBytes(32).toString('base64url')}`;
      const row = await trx
        .insertInto('api_keys')
        .values({
          tenant_id: auth.tenantId,
          source_id: source.id,
          name: dto.name,
          key_prefix: key.slice(0, 8),
          key_hash: hashApiKey(key),
          created_by: auth.userId,
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();
      await this.audit.write(trx, {
        tenantId: auth.tenantId, actorId: auth.userId, action: 'api_key.create', entity: 'api_key', entityId: row.id,
        after: { name: dto.name, source: source.name }, ip: auth.ip, requestId: auth.requestId,
      });
      return { id: row.id, name: dto.name, source: { id: source.id, name: source.name }, prefix: key.slice(0, 8), key };
    });
  }

  revokeKey(auth: AuthContext, id: string): Promise<void> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const row = await trx
        .updateTable('api_keys')
        .set({ revoked_at: sql`now()` })
        .where('id', '=', id)
        .where('revoked_at', 'is', null)
        .returning(['id', 'name'])
        .executeTakeFirst();
      if (!row) throw AppError.notFound('API key');
      await this.audit.write(trx, {
        tenantId: auth.tenantId, actorId: auth.userId, action: 'api_key.revoke', entity: 'api_key', entityId: id,
        after: { name: row.name }, ip: auth.ip, requestId: auth.requestId,
      });
    });
  }

  // ----------------------------------------------------------------- events

  listEvents(auth: AuthContext, query: { status?: string; limit: number; cursor?: string }): Promise<Page<EventView>> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const after = decodeCursor(query.cursor, cursorShape);
      const conditions = [sql<SqlBool>`true`];
      if (query.status) conditions.push(sql<SqlBool>`e.status = ${query.status}`);
      if (after) conditions.push(sql<SqlBool>`(e.received_at, e.id) < (${after.t}::timestamptz, ${after.i}::uuid)`);

      const { rows } = await sql<{
        id: string; source: string | null; external_id: string; status: string; attempts: number; error: string | null;
        received_at: Date; processed_at: Date | null; received_text: string;
      }>`
        SELECT e.id, s.name AS source, e.external_id, e.status, e.attempts, e.error, e.received_at, e.processed_at,
               e.received_at::text AS received_text
        FROM inbound_events e LEFT JOIN lead_sources s ON s.id = e.source_id
        WHERE ${sql.join(conditions, sql` AND `)}
        ORDER BY e.received_at DESC, e.id DESC
        LIMIT ${query.limit + 1}`.execute(trx);
      const page = toPage(rows, query.limit, (last) => ({ t: last.received_text, i: last.id }));
      return {
        items: page.items.map((r) => ({
          id: r.id, source: r.source, externalId: r.external_id, status: r.status, attempts: r.attempts, error: r.error,
          receivedAt: r.received_at, processedAt: r.processed_at,
        })),
        nextCursor: page.nextCursor,
      };
    });
  }

  /** The raw payload of one event, to see what a source actually sent. It contains personal details, so viewing it is logged. */
  getEvent(auth: AuthContext, id: string) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const row = await trx
        .selectFrom('inbound_events')
        .select(['id', 'status', 'payload', 'result', 'error', 'attempts'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (!row) throw AppError.notFound('Event');
      await this.audit.write(trx, {
        tenantId: auth.tenantId, actorId: auth.userId, action: 'intake_event.view', entity: 'intake_event', entityId: id,
        ip: auth.ip, requestId: auth.requestId,
      });
      return row;
    });
  }

  /** Puts a failed or refused event back in the queue and tries it now. */
  async retryEvent(auth: AuthContext, id: string) {
    await this.db.withTenant(auth.tenantId, async (trx) => {
      const row = await trx
        .updateTable('inbound_events')
        .set({ status: 'received', attempts: 0, error: null, last_attempt_at: null })
        .where('id', '=', id)
        .where('status', 'in', ['failed', 'ignored'])
        .returning('id')
        .executeTakeFirst();
      if (!row) throw AppError.conflict('NOT_RETRYABLE', 'Only a failed or refused event can be tried again');
      await this.audit.write(trx, {
        tenantId: auth.tenantId, actorId: auth.userId, action: 'intake_event.retry', entity: 'intake_event', entityId: id,
        ip: auth.ip, requestId: auth.requestId,
      });
    });
    const outcome = await this.intake.process(auth.tenantId, id);
    if (outcome.kind === 'done') return { outcome: outcome.result.outcome, leadId: outcome.result.leadId ?? null };
    if (outcome.kind === 'invalid') return { outcome: 'invalid' as const, errors: outcome.errors };
    return { outcome: 'queued' as const };
  }
}
