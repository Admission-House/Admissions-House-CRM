import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Trx } from '../database/database.service.js';
import { DEFAULT_DOWNLOAD_FORMS } from '../intake/intake-rules.js';

export type ActivityType =
  | 'note'
  | 'status_change'
  | 'assignment'
  | 'call'
  | 'document'
  | 'shortlist'
  | 'enquiry'
  | 'field_change'
  | 'followup';

export interface NewLead {
  tenantId: string;
  name: string;
  email?: string | null;
  /** Country code plus digits. */
  phone: string;
  statusId: string;
  sourceId: string;
  studyMode?: 'online' | 'regular' | null;
  intent?: 'hot' | 'warm' | 'cold' | null;
  expectedClosureOn?: string | null;
  assignedTo?: string | null;
  interestedLocationId?: string | null;
  interestedCourseId?: string | null;
  interestNote?: string | null;
  createdBy?: string | null;
}

export interface NewActivity {
  tenantId: string;
  leadId: string;
  /** Null for the system. */
  userId?: string | null;
  type: ActivityType;
  field?: string | null;
  oldValue?: string | null;
  newValue?: string | null;
  remark?: string | null;
}

/**
 * The two writes every way of making or changing a lead shares: inserting the lead row and adding
 * to its history. Keeping them here means a lead made by the website, by an import and by hand are
 * numbered, assigned and recorded in exactly the same way.
 */
@Injectable()
export class LeadWriter {
  /** The company's rules for new leads. Without a saved choice: add repeat enquiries to the lead, assign automatically. */
  async policy(trx: Trx): Promise<{ duplicateAction: 'reject' | 'attach'; autoAssign: boolean; downloadForms: string[] }> {
    const row = await trx.selectFrom('lead_policies').select(['duplicate_action', 'auto_assign', 'download_forms']).executeTakeFirst();
    return { duplicateAction: (row?.duplicate_action as 'reject' | 'attach' | undefined) ?? 'attach', autoAssign: row?.auto_assign ?? true, downloadForms: row?.download_forms ?? DEFAULT_DOWNLOAD_FORMS };
  }

  /** The status new leads start in: the first active one in the "fresh" queue. */
  async freshStatusId(trx: Trx): Promise<string> {
    const status = await trx
      .selectFrom('lead_statuses')
      .select('id')
      .where('queue', '=', 'fresh')
      .where('is_active', '=', true)
      .orderBy('sort_order')
      .executeTakeFirst();
    if (!status) throw new Error('this company has no active status in the "fresh" queue; leads cannot be filed');
    return status.id;
  }

  /**
   * Adds a lead and gives it the next Lead ID. Returns undefined, having changed nothing, if a live
   * lead already has this phone number.
   *
   * assigned_at is the real moment of assignment (clock_timestamp), not the start of the transaction
   * (now()): a request that waited for the assignment lock began earlier than it was served, and
   * round robin reads this column to see who was given a lead longest ago.
   */
  async insertLead(trx: Trx, d: NewLead): Promise<{ id: string; leadNo: string } | undefined> {
    const { rows } = await sql<{ id: string; lead_no: string }>`
      INSERT INTO leads (tenant_id, lead_no, name, email, primary_phone, status_id, source_id, study_mode, intent,
                         expected_closure_on, assigned_to, assigned_at, interested_location_id, interested_course_id,
                         interest_note, created_by, updated_by)
      VALUES (${d.tenantId}, next_counter('lead'), ${d.name}, ${d.email ?? null}, ${d.phone}, ${d.statusId}, ${d.sourceId},
              ${d.studyMode ?? null}, ${d.intent ?? null}, ${d.expectedClosureOn ?? null}::date, ${d.assignedTo ?? null},
              ${d.assignedTo ? sql`clock_timestamp()` : null}, ${d.interestedLocationId ?? null}, ${d.interestedCourseId ?? null},
              ${d.interestNote ?? null}, ${d.createdBy ?? null}, ${d.createdBy ?? null})
      ON CONFLICT (tenant_id, primary_phone) WHERE deleted_at IS NULL DO NOTHING
      RETURNING id, lead_no::text AS lead_no`.execute(trx);
    const row = rows[0];
    return row && { id: row.id, leadNo: row.lead_no };
  }

  /** Adds an entry to the lead's history. */
  async activity(trx: Trx, a: NewActivity): Promise<void> {
    await trx
      .insertInto('lead_activities')
      .values({
        tenant_id: a.tenantId,
        lead_id: a.leadId,
        user_id: a.userId ?? null,
        type: a.type,
        field: a.field ?? null,
        old_value: a.oldValue ?? null,
        new_value: a.newValue ?? null,
        remark: a.remark ?? null,
      })
      .execute();
  }
}
