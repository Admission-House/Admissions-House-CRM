import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Trx } from '../database/database.service.js';
import { LeadIngestService } from '../intake/lead-ingest.service.js';
import { LeadWriter } from '../leads/lead-writer.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type { CallEvent } from './call-events.js';

export const INCOMING_CALLS_SOURCE = 'Incoming Calls';

type Outcome = 'requested' | 'ringing' | 'connected' | 'not_picked' | 'busy' | 'failed' | 'missed';

interface CallRow {
  id: string;
  started_at: Date;
  /** The start time exactly as the database holds it. A JavaScript Date drops microseconds, which would no longer match the row. */
  started_text: string;
  lead_id: string | null;
  user_id: string | null;
  direction: 'incoming' | 'outgoing';
  counterparty: string;
  answered_at: Date | null;
  ended_at: Date | null;
  outcome: Outcome;
}

/**
 * Applies a provider's call events to the call log. Events can arrive late, twice, or in the wrong
 * order, so each one only moves a call forward: a connected call stays connected, and a time
 * already recorded is not overwritten. A call that nobody answered becomes a Missed Call lead.
 */
@Injectable()
export class CallEventsService {
  constructor(
    private readonly writer: LeadWriter,
    private readonly ingest: LeadIngestService,
    private readonly notifications: NotificationsService,
  ) {}

  async apply(trx: Trx, tenantId: string, e: CallEvent): Promise<{ callId: string; outcome: Outcome }> {
    let call = await this.find(trx, e.providerCallId);
    if (!call) call = await this.create(trx, tenantId, e);

    if (e.event === 'recording') {
      if (e.recordingUrl) {
        await sql`
          INSERT INTO call_recordings (tenant_id, call_id, call_started_at, source_url, duration_sec)
          VALUES (${tenantId}, ${call.id}, ${call.started_text}::timestamptz, ${e.recordingUrl}, ${e.durationSec ?? null})
          ON CONFLICT (tenant_id, call_id) DO NOTHING`.execute(trx);
      }
      return { callId: call.id, outcome: call.outcome };
    }

    const before = call.outcome;
    const next = await this.advance(trx, call, e);

    if (next.outcome === 'missed' && before !== 'missed' && call.direction === 'incoming') await this.missedCall(trx, tenantId, next);
    if (next.ended_at && !call.ended_at) await this.logOnLead(trx, tenantId, next);
    return { callId: next.id, outcome: next.outcome };
  }

  // ------------------------------------------------------------------ steps

  private async find(trx: Trx, providerCallId: string): Promise<CallRow | undefined> {
    const { rows } = await sql<CallRow>`
      SELECT id, started_at, started_at::text AS started_text, lead_id, user_id, direction, counterparty, answered_at, ended_at, outcome
      FROM calls WHERE provider_call_id = ${providerCallId} LIMIT 1`.execute(trx);
    return rows[0];
  }

  /** A call the CRM did not start itself: an incoming call, or one placed from the phone. */
  private async create(trx: Trx, tenantId: string, e: CallEvent): Promise<CallRow> {
    const leadId = await this.leadByPhone(trx, e.customerNumber);
    const userId = e.agentNumber ? await this.userByPhone(trx, e.agentNumber) : null;
    const { rows } = await sql<CallRow>`
      INSERT INTO calls (tenant_id, lead_id, user_id, direction, provider_call_id, counterparty, started_at, outcome)
      VALUES (${tenantId}, ${leadId}, ${userId}, ${e.direction}, ${e.providerCallId}, ${e.customerNumber}, ${e.at}, 'ringing')
      RETURNING id, started_at, started_at::text AS started_text, lead_id, user_id, direction, counterparty, answered_at, ended_at, outcome`.execute(trx);
    return rows[0]!;
  }

  private async advance(trx: Trx, call: CallRow, e: CallEvent): Promise<CallRow> {
    // A time before the call began is a clock difference between systems; keep the log consistent.
    const at = e.at < call.started_at ? call.started_at : e.at;
    let outcome = call.outcome;
    let answeredAt = call.answered_at;
    let endedAt = call.ended_at;
    let duration: number | null = null;

    switch (e.event) {
      case 'ringing':
        if (outcome === 'requested') outcome = 'ringing';
        break;
      case 'answered':
        answeredAt ??= at;
        outcome = 'connected';
        break;
      case 'ended':
        endedAt ??= at;
        // Talk time means someone answered, even if the "answered" event has not arrived yet.
        if ((e.durationSec ?? 0) > 0) outcome = 'connected';
        else if (outcome !== 'connected') outcome = e.outcome ?? (call.direction === 'incoming' ? 'missed' : 'not_picked');
        duration = outcome === 'connected' ? (e.durationSec ?? (answeredAt ? Math.max(0, Math.round((endedAt.getTime() - answeredAt.getTime()) / 1000)) : 0)) : 0;
        break;
      case 'missed':
        endedAt ??= at;
        if (outcome !== 'connected') outcome = 'missed';
        break;
      case 'failed':
        endedAt ??= at;
        if (outcome !== 'connected') outcome = 'failed';
        break;
    }

    const { rows } = await sql<CallRow>`
      UPDATE calls SET outcome = ${outcome}, answered_at = ${answeredAt}, ended_at = ${endedAt},
                       duration_sec = coalesce(${duration}, duration_sec)
      WHERE id = ${call.id} AND started_at = ${call.started_text}::timestamptz
      RETURNING id, started_at, started_at::text AS started_text, lead_id, user_id, direction, counterparty, answered_at, ended_at, outcome`.execute(trx);
    return rows[0]!;
  }

  /** What happens when a student's call goes unanswered: the lead is created or updated and put in the Missed queue. */
  private async missedCall(trx: Trx, tenantId: string, call: CallRow): Promise<void> {
    let leadId = call.lead_id ?? (await this.leadByPhone(trx, call.counterparty));
    let assignedTo: string | null = null;

    if (!leadId) {
      const sourceId = await this.incomingCallsSource(trx, tenantId);
      const res = await this.ingest.ingest(trx, {
        tenantId, sourceId, eventId: null,
        lead: { name: `Missed call ${call.counterparty.slice(-4)}`, phone: call.counterparty, formName: 'missed call', utm: {} },
      });
      leadId = res.leadId ?? null;
      assignedTo = res.assignedTo ?? null;
    }
    if (!leadId) return;
    await sql`UPDATE calls SET lead_id = ${leadId} WHERE id = ${call.id} AND started_at = ${call.started_text}::timestamptz`.execute(trx);

    const { rows } = await sql<{ assigned_to: string | null; lead_no: string; name: string; status_id: string; status: string; is_open: boolean; queue: string }>`
      SELECT l.assigned_to, l.lead_no::text AS lead_no, l.name, l.status_id, s.name AS status, s.is_open, s.queue
      FROM leads l JOIN lead_statuses s ON s.id = l.status_id WHERE l.id = ${leadId}`.execute(trx);
    const lead = rows[0]!;
    assignedTo ??= lead.assigned_to;

    if (lead.is_open && lead.queue !== 'missed') {
      const target = await sql<{ id: string; name: string }>`
        SELECT id, name FROM lead_statuses WHERE queue = 'missed' AND is_open AND is_active ORDER BY sort_order LIMIT 1`.execute(trx);
      if (target.rows[0]) {
        await sql`UPDATE leads SET status_id = ${target.rows[0].id}, updated_at = now() WHERE id = ${leadId}`.execute(trx);
        await this.writer.activity(trx, { tenantId, leadId, type: 'status_change', field: 'status', oldValue: lead.status, newValue: target.rows[0].name, remark: 'Missed call' });
      }
    }
    await this.writer.activity(trx, { tenantId, leadId, type: 'call', remark: `Missed call from ${call.counterparty}` });
    if (assignedTo) {
      await this.notifications.notify(trx, {
        tenantId, userIds: [assignedTo], type: 'lead_new',
        payload: { event: 'missed_call', leadId, leadNo: lead.lead_no, name: lead.name, phone: call.counterparty },
      });
    }
  }

  /** One line in the lead's history when a call that was answered or tried comes to an end. */
  private async logOnLead(trx: Trx, tenantId: string, call: CallRow): Promise<void> {
    if (!call.lead_id || (call.outcome === 'missed' && call.direction === 'incoming')) return; // a missed call is logged above
    const { rows } = await sql<{ duration_sec: number | null }>`SELECT duration_sec FROM calls WHERE id = ${call.id} AND started_at = ${call.started_text}::timestamptz`.execute(trx);
    const secs = rows[0]?.duration_sec ?? 0;
    const label = call.outcome === 'connected' ? `connected, ${Math.floor(secs / 60)} min ${secs % 60} s` : call.outcome.replace('_', ' ');
    await this.writer.activity(trx, { tenantId, leadId: call.lead_id, userId: call.user_id, type: 'call', remark: `${call.direction === 'incoming' ? 'Incoming' : 'Outgoing'} call ${label}` });
  }

  // ---------------------------------------------------------------- lookups

  private async leadByPhone(trx: Trx, phone: string): Promise<string | null> {
    const { rows } = await sql<{ id: string }>`
      SELECT l.id FROM leads l
      WHERE l.deleted_at IS NULL AND (l.primary_phone = ${phone} OR EXISTS (SELECT 1 FROM lead_phones x WHERE x.lead_id = l.id AND x.phone = ${phone}))
      LIMIT 1`.execute(trx);
    return rows[0]?.id ?? null;
  }

  /** An active user whose own number this is. Matched on the last ten digits so +91 or a leading 0 do not matter. */
  private async userByPhone(trx: Trx, phone: string): Promise<string | null> {
    const { rows } = await sql<{ id: string }>`
      SELECT u.id FROM users u WHERE u.status = 'active' AND u.phone IS NOT NULL AND right(u.phone, 10) = ${phone.slice(-10)} LIMIT 2`.execute(trx);
    return rows.length === 1 ? rows[0]!.id : null;
  }

  private async incomingCallsSource(trx: Trx, tenantId: string): Promise<string> {
    const { rows } = await sql<{ id: string }>`
      INSERT INTO lead_sources (tenant_id, name, channel_type) VALUES (${tenantId}, ${INCOMING_CALLS_SOURCE}, 'call')
      ON CONFLICT (tenant_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`.execute(trx);
    return rows[0]!.id;
  }
}
