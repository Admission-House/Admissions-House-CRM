import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { AppError, FieldError } from '../common/app-error.js';
import { DatabaseService } from '../database/database.service.js';
import type { IntakeContext } from './api-key.guard.js';
import { IngestResult, LeadIngestService } from './lead-ingest.service.js';
import { deriveExternalId, parseIntake } from './intake-rules.js';

/** After this many failed tries an event waits for a person (see the integrations screen). */
const MAX_ATTEMPTS = 5;

export type IntakeOutcome =
  | { kind: 'done'; result: IngestResult; replay: boolean }
  | { kind: 'invalid'; errors: FieldError[] }
  | { kind: 'queued'; eventId: string };

interface EventRow {
  id: string;
  status: 'received' | 'processed' | 'failed' | 'ignored';
  payload: unknown;
  source_id: string | null;
  result: IngestResult | null;
  error: string | null;
}

/**
 * Takes in leads from outside. The order matters:
 *   1. Save the raw event. From here on, nothing the sender sent can be lost.
 *   2. Turn it into a lead (or a note on an existing lead) in a separate transaction.
 * If step 2 fails, the event stays saved and is tried again later; the sender is told "accepted",
 * because it is. A delivery sent twice is recognised and answered with the first outcome.
 */
@Injectable()
export class IntakeService {
  private readonly logger = new Logger(IntakeService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly ingest: LeadIngestService,
  ) {}

  async receive(ctx: IntakeContext, raw: unknown, idempotencyKey: string | undefined): Promise<IntakeOutcome> {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw AppError.badRequest('BAD_PAYLOAD', 'Send the lead as a JSON object');
    }
    const externalId = deriveExternalId(idempotencyKey, raw);

    const eventId = await this.db.withTenant(ctx.tenantId, async (trx) => {
      const inserted = await sql<{ id: string }>`
        INSERT INTO inbound_events (tenant_id, provider, external_id, payload, source_id, api_key_id)
        VALUES (${ctx.tenantId}, ${`intake:${ctx.sourceId}`}, ${externalId}, ${JSON.stringify(raw)}::jsonb, ${ctx.sourceId}, ${ctx.apiKeyId})
        ON CONFLICT (tenant_id, provider, external_id) DO NOTHING
        RETURNING id`.execute(trx);
      if (inserted.rows[0]) return inserted.rows[0].id;
      const existing = await sql<{ id: string }>`
        SELECT id FROM inbound_events WHERE provider = ${`intake:${ctx.sourceId}`} AND external_id = ${externalId}`.execute(trx);
      return existing.rows[0]!.id;
    });
    return this.process(ctx.tenantId, eventId);
  }

  /** Turns one saved event into a lead. Safe to call more than once for the same event. */
  async process(tenantId: string, eventId: string): Promise<IntakeOutcome> {
    try {
      return await this.db.withTenant(tenantId, async (trx): Promise<IntakeOutcome> => {
        // SKIP LOCKED: if another request or the retry job is on this event right now, leave it to them.
        const { rows } = await sql<EventRow>`
          SELECT id, status, payload, source_id, result, error FROM inbound_events
          WHERE id = ${eventId} FOR UPDATE SKIP LOCKED`.execute(trx);
        const event = rows[0];
        if (!event) return { kind: 'queued', eventId };

        if (event.status === 'processed' && event.result) return { kind: 'done', result: event.result, replay: true };
        if (event.status === 'ignored') return { kind: 'invalid', errors: readErrors(event.error) };

        const parsed = parseIntake(event.payload);
        if (!parsed.ok) {
          await sql`
            UPDATE inbound_events SET status = 'ignored', error = ${JSON.stringify(parsed.errors)},
                   attempts = attempts + 1, last_attempt_at = now() WHERE id = ${eventId}`.execute(trx);
          return { kind: 'invalid', errors: parsed.errors };
        }
        if (!event.source_id) throw new Error('the event has no lead source');

        const result = await this.ingest.ingest(trx, { tenantId, sourceId: event.source_id, eventId, lead: parsed.lead });
        await sql`
          UPDATE inbound_events SET status = 'processed', processed_at = now(), last_attempt_at = now(),
                 attempts = attempts + 1, error = NULL, result = ${JSON.stringify(result)}::jsonb WHERE id = ${eventId}`.execute(trx);
        return { kind: 'done', result, replay: false };
      });
    } catch (err) {
      // The transaction above rolled back, including any lead it had started. The event itself is
      // safe (it was saved earlier), so record the failure in a new transaction and try again later.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`event ${eventId} could not be turned into a lead: ${message}`);
      await this.db.withTenant(tenantId, async (trx) => {
        await sql`
          UPDATE inbound_events SET status = 'failed', attempts = attempts + 1, last_attempt_at = now(),
                 error = ${message.slice(0, 500)} WHERE id = ${eventId} AND status <> 'processed'`.execute(trx);
      });
      return { kind: 'queued', eventId };
    }
  }

  /**
   * Tries again the events that did not become leads. A failed event waits longer after each try
   * (about 1, 4, 9 minutes and so on), so a problem on our side is not hammered.
   */
  async retryDue(): Promise<number> {
    const { rows: tenants } = await sql<{ id: string }>`SELECT list_active_tenant_ids() AS id`.execute(this.db.unscoped());
    let tried = 0;
    for (const { id: tenantId } of tenants) {
      const due = await this.db.withTenant(tenantId, async (trx) => {
        const { rows } = await sql<{ id: string }>`
          SELECT id FROM inbound_events
          WHERE status IN ('received', 'failed') AND attempts < ${MAX_ATTEMPTS}
            AND COALESCE(last_attempt_at, received_at) < now() - make_interval(secs => 30 + attempts * attempts * 60)
          ORDER BY received_at LIMIT 20`.execute(trx);
        return rows;
      });
      for (const { id } of due) {
        await this.process(tenantId, id);
        tried++;
      }
    }
    return tried;
  }
}

function readErrors(stored: string | null): FieldError[] {
  try {
    const parsed = JSON.parse(stored ?? '[]') as FieldError[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
