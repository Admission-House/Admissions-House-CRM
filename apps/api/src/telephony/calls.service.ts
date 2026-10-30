import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { sql, SqlBool } from 'kysely';
import { scopeCondition } from '../access/scope.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppError } from '../common/app-error.js';
import { decodeCursor, Page, toPage } from '../common/pagination.js';
import { normalizePhone } from '../common/phone.js';
import { DatabaseService, Trx } from '../database/database.service.js';
import { AuditService } from '../audit/audit.service.js';
import { FileLinks } from '../storage/file-links.service.js';
import { StorageService } from '../storage/storage.service.js';
import { LeadAccess } from '../leads/lead-access.js';
import { LeadsService } from '../leads/leads.service.js';
import { z } from 'zod';
import type { ListCallsDto, WrapUpDto } from './calls.dto.js';
import { ProviderRegistry } from './providers/registry.js';
import { TelephonySettingsService } from './telephony-settings.service.js';

/** A call that has been asked for but not yet connected is not "in progress" forever. */
const STALE_AFTER_SEC = 120;

export interface CallView {
  id: string;
  direction: 'incoming' | 'outgoing';
  number: string;
  startedAt: Date;
  answeredAt: Date | null;
  endedAt: Date | null;
  durationSec: number | null;
  outcome: string;
  lead: { id: string; leadNo: string; name: string } | null;
  user: { id: string; name: string } | null;
  wrappedUp: boolean;
  remark: string | null;
  recording: 'none' | 'pending' | 'stored' | 'failed';
}

interface Row {
  id: string; direction: 'incoming' | 'outgoing'; counterparty: string; started_at: Date; answered_at: Date | null; ended_at: Date | null;
  duration_sec: number | null; outcome: string; lead_id: string | null; lead_no: string | null; lead_name: string | null; user_id: string | null;
  user_name: string | null; wrapped_up_at: Date | null; remark: string | null; recording: string | null; started_text: string;
}

const cursorShape = z.object({ t: z.string(), i: z.string() });

const SELECT = sql`
  SELECT c.id, c.direction, c.counterparty, c.started_at, c.answered_at, c.ended_at, c.duration_sec, c.outcome, c.lead_id,
         l.lead_no::text AS lead_no, l.name AS lead_name, c.user_id, u.name AS user_name, c.wrapped_up_at, c.remark,
         r.status AS recording, c.started_at::text AS started_text
  FROM calls c
  LEFT JOIN leads l ON l.id = c.lead_id
  LEFT JOIN users u ON u.id = c.user_id
  LEFT JOIN call_recordings r ON r.call_id = c.id AND r.call_started_at = c.started_at
  CROSS JOIN tenants t`;

@Injectable()
export class CallsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: LeadAccess,
    private readonly leads: LeadsService,
    private readonly registry: ProviderRegistry,
    private readonly settings: TelephonySettingsService,
    private readonly audit: AuditService,
    private readonly links: FileLinks,
    private readonly storage: StorageService,
  ) {}

  // ------------------------------------------------------------ place a call

  /** Rings the counsellor's own phone through the provider, which then connects the student. */
  async place(auth: AuthContext, leadId: string, input: { phone?: string }, dialerSessionId?: string): Promise<CallView> {
    const pending = await this.db.withTenant(auth.tenantId, async (trx) => {
      const lead = await this.access.get(trx, auth, leadId);
      const connection = await this.settings.credentials(trx, auth.tenantId);
      if (!connection?.isEnabled) throw new AppError('TELEPHONY_NOT_CONFIGURED', 'Calling is not set up for this company yet', 409);

      const agent = await trx.selectFrom('users').select('phone').where('id', '=', auth.userId).executeTakeFirst();
      if (!agent?.phone) throw new AppError('NO_AGENT_NUMBER', 'Add your own mobile number to your profile first. The call rings your phone.', 422);

      const customer = await this.numberFor(trx, lead.id, lead.primary_phone, input.phone);
      const { rows: busy } = await sql<{ id: string }>`
        SELECT id FROM calls WHERE user_id = ${auth.userId} AND outcome IN ('requested', 'ringing')
          AND started_at > now() - make_interval(secs => ${STALE_AFTER_SEC}) LIMIT 1`.execute(trx);
      if (busy[0]) throw new AppError('CALL_IN_PROGRESS', 'You already have a call in progress', 409);

      const { rows } = await sql<{ id: string }>`
        INSERT INTO calls (tenant_id, lead_id, user_id, direction, provider_call_id, counterparty, started_at, outcome, dialer_session_id)
        VALUES (${auth.tenantId}, ${lead.id}, ${auth.userId}, 'outgoing', ${`crm-${randomUUID()}`}, ${customer}, clock_timestamp(), 'requested', ${dialerSessionId ?? null})
        RETURNING id`.execute(trx);
      return { callId: rows[0]!.id, connection, agentNumber: agent.phone, customer };
    });

    // The provider is called outside the transaction: a slow provider must not hold a database connection.
    try {
      const provider = this.registry.get(pending.connection.provider);
      const { providerCallId } = await provider.placeCall(pending.connection.config, {
        callId: pending.callId, agentNumber: pending.agentNumber, customerNumber: pending.customer,
      });
      await this.db.withTenant(auth.tenantId, (trx) => sql`UPDATE calls SET provider_call_id = ${providerCallId} WHERE id = ${pending.callId}`.execute(trx));
    } catch (err) {
      await this.db.withTenant(auth.tenantId, (trx) =>
        sql`UPDATE calls SET outcome = 'failed', ended_at = clock_timestamp() WHERE id = ${pending.callId}`.execute(trx),
      );
      if (err instanceof AppError) throw err;
      throw new AppError('PROVIDER_ERROR', 'The calling service did not accept the call. Try again in a moment.', 502);
    }
    return this.get(auth, pending.callId);
  }

  private async numberFor(trx: Trx, leadId: string, primary: string, chosen: string | undefined): Promise<string> {
    if (!chosen) return primary;
    const phone = normalizePhone(chosen);
    if (!phone) throw AppError.badRequest('PHONE_INVALID', 'Enter a valid mobile number', [{ field: 'phone', message: 'Enter a valid mobile number' }]);
    if (phone === primary) return phone;
    const own = await trx.selectFrom('lead_phones').select('phone').where('lead_id', '=', leadId).where('phone', '=', phone).executeTakeFirst();
    if (!own) throw AppError.badRequest('PHONE_NOT_ON_LEAD', 'That number is not one of this lead\'s numbers', [{ field: 'phone', message: 'Choose one of the lead\'s numbers' }]);
    return phone;
  }

  // ------------------------------------------------------------------ reads

  list(auth: AuthContext, query: ListCallsDto): Promise<Page<CallView>> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const after = decodeCursor(query.cursor, cursorShape);
      const c: ReturnType<typeof sql<SqlBool>>[] = [sql<SqlBool>`true`];
      const scoped = scopeCondition(auth, 'c.user_id');
      if (scoped) c.push(scoped as never);
      if (query.leadId) c.push(sql<SqlBool>`c.lead_id = ${query.leadId}::uuid`);
      if (query.userId) c.push(sql<SqlBool>`c.user_id = ${query.userId}::uuid`);
      if (query.direction) c.push(sql<SqlBool>`c.direction = ${query.direction}`);
      if (query.outcome) c.push(sql<SqlBool>`c.outcome = ${query.outcome}`);
      if (query.from) c.push(sql<SqlBool>`c.started_at >= (${query.from}::date::timestamp AT TIME ZONE t.timezone)`);
      if (query.to) c.push(sql<SqlBool>`c.started_at < ((${query.to}::date + 1)::timestamp AT TIME ZONE t.timezone)`);
      if (query.unwrapped !== undefined) c.push(query.unwrapped ? sql<SqlBool>`(c.wrapped_up_at IS NULL AND c.lead_id IS NOT NULL AND c.outcome = 'connected')` : sql<SqlBool>`c.wrapped_up_at IS NOT NULL`);
      if (after) c.push(sql<SqlBool>`(c.started_at, c.id) < (${after.t}::timestamptz, ${after.i}::uuid)`);

      const { rows } = await sql<Row>`${SELECT} WHERE ${sql.join(c, sql` AND `)} ORDER BY c.started_at DESC, c.id DESC LIMIT ${query.limit + 1}`.execute(trx);
      const page = toPage(rows, query.limit, (last) => ({ t: last.started_text, i: last.id }));
      return { items: page.items.map(toView), nextCursor: page.nextCursor };
    });
  }

  /** The calls with one lead, for the lead's page. Anyone who may see the lead sees its calls. */
  forLead(auth: AuthContext, leadId: string, query: { limit: number; cursor?: string }): Promise<Page<CallView>> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      await this.access.get(trx, auth, leadId);
      const after = decodeCursor(query.cursor, cursorShape);
      const { rows } = await sql<Row>`
        ${SELECT} WHERE c.lead_id = ${leadId}::uuid ${after ? sql`AND (c.started_at, c.id) < (${after.t}::timestamptz, ${after.i}::uuid)` : sql``}
        ORDER BY c.started_at DESC, c.id DESC LIMIT ${query.limit + 1}`.execute(trx);
      const page = toPage(rows, query.limit, (last) => ({ t: last.started_text, i: last.id }));
      return { items: page.items.map(toView), nextCursor: page.nextCursor };
    });
  }

  get(auth: AuthContext, id: string): Promise<CallView> {
    return this.db.withTenant(auth.tenantId, async (trx) => toView(await this.one(trx, auth, id)));
  }

  private async one(trx: Trx, auth: AuthContext, id: string): Promise<Row> {
    const scoped = scopeCondition(auth, 'c.user_id');
    const { rows } = await sql<Row>`${SELECT} WHERE c.id = ${id}::uuid ${scoped ? sql`AND ${scoped}` : sql``}`.execute(trx);
    if (!rows[0]) throw AppError.notFound('Call');
    return rows[0];
  }

  // ------------------------------------------------------------- recordings

  /** The recording of a call, for someone allowed to listen. Every use is written to the audit log. */
  async recording(auth: AuthContext, id: string) {
    const file = await this.recordingFile(auth, id);
    const stream = await this.storage.get(file.key);
    if (!stream) throw AppError.notFound('Recording');
    return { ...stream, type: file.type, name: file.name };
  }

  /** A short-lived link a browser audio player can use without a login header. */
  async recordingLink(auth: AuthContext, id: string): Promise<{ url: string; expiresAt: Date }> {
    const file = await this.recordingFile(auth, id);
    const { token, expiresAt } = this.links.sign({ key: file.key, type: file.type, name: file.name });
    return { url: `/api/v1/files/${token}`, expiresAt };
  }

  private recordingFile(auth: AuthContext, id: string): Promise<{ key: string; type: string; name: string }> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const call = await this.one(trx, auth, id);
      const { rows } = await sql<{ file_key: string | null; status: string }>`
        SELECT file_key, status FROM call_recordings WHERE call_id = ${id}::uuid`.execute(trx);
      const rec = rows[0];
      if (!rec) throw AppError.notFound('Recording');
      if (rec.status !== 'stored' || !rec.file_key) {
        throw new AppError('RECORDING_NOT_READY', rec.status === 'failed' ? 'This recording could not be downloaded from the provider' : 'This recording is still being downloaded. Try again in a minute.', 409);
      }
      await this.audit.write(trx, {
        tenantId: auth.tenantId, actorId: auth.userId, action: 'call.listen', entity: 'call', entityId: id,
        after: { lead: call.lead_id, number: call.counterparty }, ip: auth.ip, requestId: auth.requestId,
      });
      const ext = rec.file_key.split('.').pop() ?? 'bin';
      const mime: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4' };
      return { key: rec.file_key, type: mime[ext] ?? 'application/octet-stream', name: `call-${call.counterparty}-${call.started_at.toISOString().slice(0, 10)}.${ext}` };
    });
  }

  // --------------------------------------------------------------- wrap up

  /**
   * The after-call form. Sets the lead's status, adds the remark to its history and, if asked,
   * schedules the next follow-up, all together. A call is wrapped up once.
   */
  wrapUp(auth: AuthContext, id: string, dto: WrapUpDto): Promise<{ call: CallView }> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const call = await this.one(trx, auth, id);
      if (!call.lead_id) throw new AppError('NO_LEAD', 'This call is not linked to a lead', 409);
      const claimed = await sql<{ id: string }>`
        UPDATE calls SET wrapped_up_at = now(), wrapped_up_by = ${auth.userId}, remark = ${dto.remark ?? null}
        WHERE id = ${id}::uuid AND started_at = ${call.started_text}::timestamptz AND wrapped_up_at IS NULL RETURNING id`.execute(trx);
      if (!claimed.rows[0]) throw new AppError('ALREADY_WRAPPED_UP', 'This call already has its after-call form', 409);

      await this.leads.changeStatusIn(trx, auth, call.lead_id, dto);
      return { call: toView(await this.one(trx, auth, id)) };
    });
  }
}

function toView(r: Row): CallView {
  return {
    id: r.id, direction: r.direction, number: r.counterparty, startedAt: r.started_at, answeredAt: r.answered_at, endedAt: r.ended_at,
    durationSec: r.duration_sec, outcome: r.outcome,
    lead: r.lead_id ? { id: r.lead_id, leadNo: r.lead_no ?? '', name: r.lead_name ?? '' } : null,
    user: r.user_id ? { id: r.user_id, name: r.user_name ?? '' } : null,
    wrappedUp: r.wrapped_up_at !== null, remark: r.remark, recording: (r.recording as CallView['recording'] | null) ?? 'none',
  };
}
