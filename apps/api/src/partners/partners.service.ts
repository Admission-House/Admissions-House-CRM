import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppError } from '../common/app-error.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { LeadAccess } from '../leads/lead-access.js';
import { LeadWriter } from '../leads/lead-writer.js';
import { buildPayload, checkChoices, PARTNERS, partnerByKey, readAnswer, withoutSecret, type Partner } from './partners.registry.js';

export const sendSchema = z.object({
  course: z.string().trim().min(1).max(200),
  specialization: z.string().trim().min(1).max(200),
  state: z.string().trim().min(1).max(80),
  city: z.string().trim().min(1).max(120),
  /** The student has already been sent to this college; send again on purpose. */
  resend: z.boolean().optional(),
});
export type SendInput = z.infer<typeof sendSchema>;

export const dnpSchema = z.object({ reason: z.string().trim().min(3).max(300) });

export interface PartnerView {
  key: string;
  name: string;
  /** The college's key has been added to the settings, so a lead can be sent. */
  configured: boolean;
  programs: { campus: string; course: string; specializations: string[] }[];
  states: string[];
}

export interface SubmissionView {
  id: string;
  partner: string;
  partnerName: string;
  state: 'sending' | 'sent' | 'failed';
  course: string | null;
  specialization: string | null;
  message: string | null;
  submittedBy: string | null;
  createdAt: Date;
  /** The student did not pick up the college's call. Shown next to the college on the lead. */
  dnp: { at: Date; reason: string | null; by: string | null } | null;
}

export interface SendResult {
  ok: boolean;
  message: string;
  submissionId: string;
}

@Injectable()
export class PartnersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: LeadAccess,
    private readonly writer: LeadWriter,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** The colleges a lead can be sent to, with their courses and states. Never the secret key. */
  list(): PartnerView[] {
    return PARTNERS.map((p) => ({
      key: p.key,
      name: p.name,
      configured: !!p.credentials(this.env).secret,
      programs: p.programs,
      states: Object.keys(p.locations),
    }));
  }

  cities(key: string, state: string): string[] {
    return this.partner(key).locations[state] ?? [];
  }

  submissions(auth: AuthContext, leadId: string): Promise<SubmissionView[]> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      await this.access.get(trx, auth, leadId);
      const { rows } = await sql<{
        id: string; partner: string; state: SubmissionView['state']; request: Record<string, string>; response: string | null; by: string | null; created_at: Date;
        dnp_at: Date | null; dnp_reason: string | null; dnp_by_name: string | null;
      }>`
        SELECT s.id, s.partner, s.state, s.request, s.response, u.name AS by, s.created_at, s.dnp_at, s.dnp_reason, d.name AS dnp_by_name
        FROM lead_partner_submissions s LEFT JOIN users u ON u.id = s.submitted_by LEFT JOIN users d ON d.id = s.dnp_by
        WHERE s.lead_id = ${leadId} ORDER BY s.created_at DESC LIMIT 50`.execute(trx);
      return rows.map((r) => ({
        id: r.id,
        partner: r.partner,
        partnerName: partnerByKey(r.partner)?.name ?? r.partner,
        state: r.state,
        course: r.request.course ?? null,
        specialization: r.request.specialization ?? null,
        message: r.response,
        submittedBy: r.by,
        createdAt: r.created_at,
        dnp: r.dnp_at ? { at: r.dnp_at, reason: r.dnp_reason, by: r.dnp_by_name } : null,
      }));
    });
  }

  /** The student did not pick up the college's call. Only for one that was sent. */
  markDnp(auth: AuthContext, leadId: string, submissionId: string, reason: string): Promise<{ ok: true }> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      await this.access.get(trx, auth, leadId, true);
      const { rows } = await sql<{ partner: string }>`
        UPDATE lead_partner_submissions SET dnp_at = now(), dnp_reason = ${reason}, dnp_by = ${auth.userId}
        WHERE id = ${submissionId} AND lead_id = ${leadId} AND state = 'sent' AND dnp_at IS NULL RETURNING partner`.execute(trx);
      if (!rows[0]) throw AppError.notFound('Sent record');
      const name = partnerByKey(rows[0].partner)?.name ?? rows[0].partner;
      await this.writer.activity(trx, { tenantId: auth.tenantId, leadId, userId: auth.userId, type: 'partner', field: rows[0].partner, newValue: 'DNP', remark: `Marked DNP with ${name}: ${reason}` });
      await this.audit.write(trx, { tenantId: auth.tenantId, actorId: auth.userId, action: 'lead.partner_dnp', entity: 'lead', entityId: leadId, after: { partner: rows[0].partner }, ip: auth.ip, requestId: auth.requestId });
      return { ok: true as const };
    });
  }

  /** Back to shortlisted. */
  undoDnp(auth: AuthContext, leadId: string, submissionId: string): Promise<{ ok: true }> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      await this.access.get(trx, auth, leadId, true);
      const { rows } = await sql<{ partner: string }>`
        UPDATE lead_partner_submissions SET dnp_at = NULL, dnp_reason = NULL, dnp_by = NULL
        WHERE id = ${submissionId} AND lead_id = ${leadId} AND dnp_at IS NOT NULL RETURNING partner`.execute(trx);
      if (!rows[0]) throw AppError.notFound('Sent record');
      await this.writer.activity(trx, { tenantId: auth.tenantId, leadId, userId: auth.userId, type: 'partner', field: rows[0].partner, newValue: 'shortlisted', remark: `Moved back to shortlisted with ${partnerByKey(rows[0].partner)?.name ?? rows[0].partner}` });
      return { ok: true as const };
    });
  }

  /**
   * Sends one lead to a college. The lead is first marked as "sending" (and committed), then the college is called with no database
   * transaction held open, then the outcome is written. Because the first step is committed, a second click or a second counsellor
   * finds the first still in flight, or already sent, and is stopped.
   */
  async send(auth: AuthContext, leadId: string, key: string, input: SendInput): Promise<SendResult> {
    const partner = this.partner(key);
    const { secret, url } = partner.credentials(this.env);
    if (!secret) throw new AppError('PARTNER_NOT_SET', `Sending to ${partner.name} is not set up yet. Ask your Super Admin to add the college's key.`, 503);

    const checked = checkChoices(partner, input);
    if ('field' in checked) throw AppError.badRequest('INVALID_CHOICE', checked.message, [{ field: checked.field, message: checked.message }]);

    const started = await this.db.withTenant(auth.tenantId, async (trx) => {
      await this.access.get(trx, auth, leadId, true);
      const { rows } = await sql<{ name: string; email: string | null; primary_phone: string; source: string }>`
        SELECT l.name, l.email::text AS email, l.primary_phone, s.name AS source
        FROM leads l JOIN lead_sources s ON s.id = l.source_id WHERE l.id = ${leadId}`.execute(trx);
      const lead = rows[0]!;
      if (!lead.email) throw AppError.badRequest('EMAIL_REQUIRED', "Add the student's email address first: the college needs it.", [{ field: 'email', message: 'The student has no email address' }]);

      const { rows: prior } = await sql<{ state: string; fresh: boolean }>`
        SELECT state, created_at > now() - interval '2 minutes' AS fresh FROM lead_partner_submissions
        WHERE lead_id = ${leadId} AND partner = ${partner.key} AND state IN ('sent', 'sending') ORDER BY created_at DESC LIMIT 5`.execute(trx);
      if (prior.some((p) => p.state === 'sending' && p.fresh)) throw AppError.conflict('SEND_IN_PROGRESS', 'This lead is being sent right now. Wait a moment.');
      if (prior.some((p) => p.state === 'sent') && !input.resend) {
        throw AppError.conflict('ALREADY_SENT', `This lead has already been sent to ${partner.name}.`);
      }

      const payload = buildPayload(partner, secret, { name: lead.name, email: lead.email, phone: lead.primary_phone, sourceName: lead.source }, input, checked.campus);
      const { rows: made } = await sql<{ id: string }>`
        INSERT INTO lead_partner_submissions (tenant_id, lead_id, partner, request, ok, state, submitted_by)
        VALUES (${auth.tenantId}, ${leadId}, ${partner.key}, ${JSON.stringify(withoutSecret(payload))}::jsonb, false, 'sending', ${auth.userId})
        RETURNING id`.execute(trx);
      return { id: made[0]!.id, payload };
    });

    let status: number | null = null;
    let text = '';
    let outcome: { ok: boolean; message: string };
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(started.payload),
        signal: AbortSignal.timeout(this.env.PARTNER_TIMEOUT_SEC * 1000),
        redirect: 'error',
      });
      status = res.status;
      text = (await res.text()).slice(0, 2000);
      outcome = readAnswer(status, text);
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      outcome = { ok: false, message: timedOut ? `${partner.name} did not answer in time. Check with them before sending again.` : `Could not reach ${partner.name}.` };
      text = outcome.message;
    }

    await this.db.withTenant(auth.tenantId, async (trx) => {
      await sql`
        UPDATE lead_partner_submissions
        SET state = ${outcome.ok ? 'sent' : 'failed'}, ok = ${outcome.ok}, http_status = ${status}, response = ${(outcome.message || text).slice(0, 500)}
        WHERE id = ${started.id}`.execute(trx);
      if (outcome.ok) {
        await this.writer.activity(trx, {
          tenantId: auth.tenantId, leadId, userId: auth.userId, type: 'partner', field: partner.key,
          newValue: `${input.course} (${input.specialization})`, remark: `Sent to ${partner.name}: ${input.course}, ${input.specialization}. ${input.city}, ${input.state}.`,
        });
      }
      await this.audit.write(trx, {
        tenantId: auth.tenantId, actorId: auth.userId, action: 'lead.partner_send', entity: 'lead', entityId: leadId,
        after: { partner: partner.key, course: input.course, specialization: input.specialization, ok: outcome.ok, status }, ip: auth.ip, requestId: auth.requestId,
      });
    });
    return { ok: outcome.ok, message: outcome.message, submissionId: started.id };
  }

  private partner(key: string): Partner {
    const p = partnerByKey(key);
    if (!p) throw AppError.notFound('College');
    return p;
  }
}
