import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Trx } from '../database/database.service.js';
import { MailerService } from '../mail/mailer.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { LeadWriter } from '../leads/lead-writer.js';
import { AssignmentService } from './assignment.service.js';
import { interestNote, IntakeLead, isDownloadForm } from './intake-rules.js';

/** How to choose the owner, when the caller decides instead of the company's automatic setting. */
export type AssignChoice = { mode: 'auto' } | { mode: 'none' } | { mode: 'user'; userId: string };

export interface IngestOptions {
  assign?: AssignChoice;
  /** No notification per lead. A bulk job sends one summary at the end instead. */
  quiet?: boolean;
}

export interface IngestResult {
  outcome: 'created' | 'attached' | 'rejected';
  leadId?: string;
  leadNo?: string;
  /** The counsellor the lead went to, if anyone. */
  assignedTo?: string | null;
}

interface ExistingLead {
  id: string;
  lead_no: string;
  assigned_to: string | null;
  name: string;
}

/**
 * Turns an intake record into a lead, or into a note on the lead that already has this phone number.
 * Everything happens in the caller's transaction, so a lead and everything that goes with it
 * (profile, enquiry, history, notifications) exist together or not at all.
 */
@Injectable()
export class LeadIngestService {
  constructor(
    private readonly assignment: AssignmentService,
    private readonly notifications: NotificationsService,
    private readonly writer: LeadWriter,
    private readonly mailer: MailerService,
  ) {}

  async ingest(trx: Trx, p: { tenantId: string; sourceId: string; eventId: string | null; lead: IntakeLead; options?: IngestOptions }): Promise<IngestResult> {
    const { lead } = p;
    const policy = await this.policy(trx);
    const source = await trx.selectFrom('lead_sources').select(['name', 'is_active']).where('id', '=', p.sourceId).executeTakeFirstOrThrow();

    const existing = await this.findByPhone(trx, lead.phone);
    if (existing) return this.handleRepeat(trx, p, existing, source.name, policy.duplicateAction, policy.downloadForms);

    const created = await this.createLead(trx, p, source.name, policy.autoAssign);
    if (created) {
      if (created.leadId && created.leadNo) await this.notifyDownload(trx, p, created.leadId, created.leadNo, policy.downloadForms);
      return created;
    }

    // The database refused a second lead for this phone: another delivery got there first.
    const winner = await this.findByPhone(trx, lead.phone);
    if (!winner) throw new Error('lead insert was refused but no lead has this phone number');
    return this.handleRepeat(trx, p, winner, source.name, policy.duplicateAction, policy.downloadForms);
  }

  // ----------------------------------------------------------------- repeat

  private async handleRepeat(
    trx: Trx,
    p: { tenantId: string; sourceId: string; eventId: string | null; lead: IntakeLead; options?: IngestOptions },
    existing: ExistingLead,
    sourceName: string,
    action: 'reject' | 'attach',
    downloadForms: readonly string[],
  ): Promise<IngestResult> {
    if (action === 'reject') return { outcome: 'rejected', leadId: existing.id, leadNo: existing.lead_no };

    await this.recordEnquiry(trx, p, existing.id);
    await this.activity(trx, p.tenantId, existing.id, 'enquiry', `Enquired again through ${describe(sourceName, p.lead)}`);
    if (existing.assigned_to && !p.options?.quiet) {
      await this.notifications.notify(trx, {
        tenantId: p.tenantId,
        userIds: [existing.assigned_to],
        type: 'lead_new',
        payload: { event: 'repeat_enquiry', leadId: existing.id, leadNo: existing.lead_no, name: existing.name, source: sourceName },
      });
    }
    await this.notifyDownload(trx, p, existing.id, existing.lead_no, downloadForms);
    return { outcome: 'attached', leadId: existing.id, leadNo: existing.lead_no, assignedTo: existing.assigned_to };
  }

  /**
   * A visitor who asked to download something (a brochure) is a warm lead: every active Super Admin gets
   * a bell notification and an email. The email is sent after this call returns and is never waited on.
   */
  private async notifyDownload(
    trx: Trx,
    p: { tenantId: string; lead: IntakeLead; options?: IngestOptions },
    leadId: string,
    leadNo: string,
    downloadForms: readonly string[],
  ): Promise<void> {
    if (p.options?.quiet || !isDownloadForm(p.lead.formName, downloadForms)) return;
    const { rows: admins } = await sql<{ id: string; email: string }>`
      SELECT u.id, u.email FROM users u JOIN roles r ON r.id = u.role_id
      WHERE r.system_key = 'super_admin' AND u.status = 'active'`.execute(trx);
    if (admins.length === 0) return;
    const what = p.lead.interest ?? p.lead.formName ?? 'a resource';
    await this.notifications.notify(trx, {
      tenantId: p.tenantId, userIds: admins.map((a) => a.id), type: 'system',
      payload: { event: 'resource_download', leadId, leadNo, name: p.lead.name, phone: p.lead.phone, resource: what, form: p.lead.formName, page: p.lead.pagePath },
    });
    const text = [`${p.lead.name} (${p.lead.phone}) asked to download: ${what}.`, p.lead.pagePath ? `Page: ${p.lead.pagePath}` : '', `Lead ID: ${leadNo}`].filter(Boolean).join('\n');
    for (const a of admins) setImmediate(() => void this.mailer.send({ to: a.email, subject: `Download request: ${what}`, text }));
  }

  // ----------------------------------------------------------------- create

  /** Returns undefined if the phone number turned out to belong to a lead created a moment ago. */
  private async createLead(
    trx: Trx,
    p: { tenantId: string; sourceId: string; eventId: string | null; lead: IntakeLead; options?: IngestOptions },
    sourceName: string,
    autoAssign: boolean,
  ): Promise<IngestResult | undefined> {
    const { lead } = p;
    const statusId = await this.writer.freshStatusId(trx);

    const locationId = await this.matchCity(trx, lead.city);
    const streamId = await this.matchStream(trx, lead.stream);
    const note = interestNote(lead, { city: !!lead.city && !locationId, stream: !!lead.stream && !streamId });

    const assignment = await this.chooseOwner(trx, p, autoAssign, locationId);

    const created = await this.writer.insertLead(trx, {
      tenantId: p.tenantId, name: lead.name, email: lead.email, phone: lead.phone, statusId, sourceId: p.sourceId,
      studyMode: lead.studyMode, assignedTo: assignment.userId, interestedLocationId: locationId, interestNote: note,
    });
    const row = created && { id: created.id, lead_no: created.leadNo };
    if (!row) return undefined;

    if (lead.level || streamId) {
      await trx
        .insertInto('lead_profiles')
        .values({ tenant_id: p.tenantId, lead_id: row.id, preferred_level: lead.level ?? null, preferred_stream_id: streamId })
        .execute();
    }
    await this.recordEnquiry(trx, p, row.id);
    await this.activity(trx, p.tenantId, row.id, 'enquiry', `New lead from ${describe(sourceName, lead)}`);

    if (assignment.userId) {
      const assignee = await trx.selectFrom('users').select('name').where('id', '=', assignment.userId).executeTakeFirstOrThrow();
      await this.activity(trx, p.tenantId, row.id, 'assignment', `Assigned ${assignment.chosen ? '' : 'automatically '}to ${assignee.name}`);
      if (!p.options?.quiet) {
        await this.notifications.notify(trx, {
          tenantId: p.tenantId, userIds: [assignment.userId], type: 'assignment',
          payload: { event: 'lead_assigned', leadId: row.id, leadNo: row.lead_no, name: lead.name, source: sourceName },
        });
      }
    } else if (!p.options?.quiet) {
      await this.notifyUnassigned(trx, p.tenantId, row.id, row.lead_no, lead.name, sourceName, assignment.reason);
    }
    return { outcome: 'created', leadId: row.id, leadNo: row.lead_no, assignedTo: assignment.userId };
  }

  /** The company's automatic setting, unless the caller named an owner or asked for none. */
  private async chooseOwner(trx: Trx, p: { tenantId: string; sourceId: string; eventId: string | null; lead: IntakeLead; options?: IngestOptions }, autoAssign: boolean, locationId: string | null): Promise<{ userId: string | null; reason: string; chosen: boolean }> {
    const choice = p.options?.assign ?? { mode: 'auto' as const };
    if (choice.mode === 'none') return { userId: null, reason: 'left_unassigned', chosen: true };
    if (choice.mode === 'user') {
      const active = await trx.selectFrom('users').select('id').where('id', '=', choice.userId).where('status', '=', 'active').executeTakeFirst();
      return active ? { userId: active.id, reason: 'chosen', chosen: true } : { userId: null, reason: 'chosen_user_inactive', chosen: true };
    }
    if (!autoAssign) return { userId: null, reason: 'auto_assign_off', chosen: false };
    const picked = await this.assignment.choose(trx, p.tenantId, { sourceId: p.sourceId, courseId: null, locationId, studyMode: p.lead.studyMode ?? null });
    return { userId: picked.userId, reason: picked.reason, chosen: false };
  }

  /** A lead nobody could be given to is something a Super Admin should see at once. */
  private async notifyUnassigned(trx: Trx, tenantId: string, leadId: string, leadNo: string, name: string, source: string, reason: string) {
    const { rows } = await sql<{ id: string }>`
      SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
      WHERE r.system_key = 'super_admin' AND u.status = 'active'`.execute(trx);
    await this.notifications.notify(trx, {
      tenantId, userIds: rows.map((r) => r.id), type: 'lead_new',
      payload: { event: 'lead_unassigned', leadId, leadNo, name, source, reason },
    });
  }

  // ---------------------------------------------------------------- helpers

  private policy(trx: Trx) {
    return this.writer.policy(trx);
  }

  /** A live lead with this number, whether it is the main number or an extra one. */
  private async findByPhone(trx: Trx, phone: string): Promise<ExistingLead | undefined> {
    const { rows } = await sql<ExistingLead>`
      SELECT l.id, l.lead_no::text AS lead_no, l.assigned_to, l.name FROM leads l
      WHERE l.deleted_at IS NULL
        AND (l.primary_phone = ${phone} OR EXISTS (SELECT 1 FROM lead_phones x WHERE x.lead_id = l.id AND x.phone = ${phone}))
      LIMIT 1`.execute(trx);
    return rows[0];
  }

  /** A city is matched only when its name is unambiguous across states. */
  private async matchCity(trx: Trx, city: string | undefined): Promise<string | null> {
    if (!city) return null;
    const rows = await trx.selectFrom('locations').select('id').where('type', '=', 'city').where(sql`lower(name)`, '=', city.toLowerCase()).limit(2).execute();
    return rows.length === 1 ? rows[0]!.id : null;
  }

  private async matchStream(trx: Trx, stream: string | undefined): Promise<string | null> {
    if (!stream) return null;
    const row = await trx.selectFrom('streams').select('id').where(sql`lower(name)`, '=', stream.toLowerCase()).executeTakeFirst();
    return row?.id ?? null;
  }

  private async recordEnquiry(trx: Trx, p: { tenantId: string; sourceId: string; eventId: string | null; lead: IntakeLead }, leadId: string): Promise<void> {
    await trx
      .insertInto('lead_enquiries')
      .values({
        tenant_id: p.tenantId, lead_id: leadId, source_id: p.sourceId, form_name: p.lead.formName ?? null,
        page_path: p.lead.pagePath ?? null, utm_source: p.lead.utm.source ?? null, utm_medium: p.lead.utm.medium ?? null,
        utm_campaign: p.lead.utm.campaign ?? null, utm_term: p.lead.utm.term ?? null, utm_content: p.lead.utm.content ?? null,
        event_id: p.eventId,
      })
      .execute();
  }

  private async activity(trx: Trx, tenantId: string, leadId: string, type: 'enquiry' | 'assignment', remark: string): Promise<void> {
    await this.writer.activity(trx, { tenantId, leadId, type, remark });
  }
}

function describe(sourceName: string, lead: IntakeLead): string {
  return lead.formName ? `${sourceName} (${lead.formName})` : sourceName;
}

