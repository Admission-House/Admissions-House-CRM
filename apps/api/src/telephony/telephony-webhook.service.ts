import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { AppError } from '../common/app-error.js';
import { DatabaseService } from '../database/database.service.js';
import { CallEvent, eventKey, ProviderPayloadError } from './call-events.js';
import { CallEventsService } from './call-events.service.js';
import { ProviderRegistry } from './providers/registry.js';
import type { TelephonyContext } from './telephony-key.guard.js';

const PROVIDER_LABEL = 'telephony';

/**
 * Receives call events from the provider. Each event is saved before it is applied, and an event
 * seen before (the provider retries when it gets no answer) is recognised and not applied twice.
 * An event that fails to apply is kept as failed and the provider is told to try again.
 */
@Injectable()
export class TelephonyWebhookService {
  private readonly logger = new Logger(TelephonyWebhookService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly registry: ProviderRegistry,
    private readonly events: CallEventsService,
  ) {}

  async receive(ctx: TelephonyContext, body: unknown): Promise<{ received: number; repeated: number }> {
    let events: CallEvent[];
    try {
      events = this.registry.get(ctx.provider).normalize(body);
    } catch (err) {
      if (err instanceof ProviderPayloadError) throw new AppError('INVALID_EVENT', err.message, 422);
      throw err;
    }

    let repeated = 0;
    for (const event of events) {
      if (!(await this.handle(ctx.tenantId, event))) repeated++;
    }
    return { received: events.length, repeated };
  }

  /** Returns false when this exact event had already been applied. */
  private async handle(tenantId: string, event: CallEvent): Promise<boolean> {
    const key = eventKey(event);
    const state = await this.db.withTenant(tenantId, async (trx) => {
      const { rows } = await sql<{ id: string; status: string }>`
        INSERT INTO inbound_events (tenant_id, provider, external_id, payload)
        VALUES (${tenantId}, ${PROVIDER_LABEL}, ${key}, ${JSON.stringify(event)}::jsonb)
        ON CONFLICT (tenant_id, provider, external_id) DO UPDATE SET attempts = inbound_events.attempts
        RETURNING id, status`.execute(trx);
      return rows[0]!;
    });
    if (state.status === 'processed') return false;

    try {
      await this.db.withTenant(tenantId, async (trx) => {
        await this.events.apply(trx, tenantId, event);
        await sql`UPDATE inbound_events SET status = 'processed', processed_at = now(), error = NULL, attempts = attempts + 1 WHERE id = ${state.id}`.execute(trx);
      });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`call event ${event.providerCallId}/${event.event} failed: ${message}`);
      await this.db.withTenant(tenantId, (trx) =>
        sql`UPDATE inbound_events SET status = 'failed', error = ${message.slice(0, 500)}, attempts = attempts + 1 WHERE id = ${state.id}`.execute(trx),
      );
      throw err;
    }
  }
}
