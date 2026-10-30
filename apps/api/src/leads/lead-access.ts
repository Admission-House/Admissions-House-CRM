import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { leadVisibility } from '../access/lead-scope.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppError } from '../common/app-error.js';
import type { Trx } from '../database/database.service.js';

export interface AccessibleLead {
  id: string;
  lead_no: string;
  name: string;
  primary_phone: string;
  assigned_to: string | null;
  study_mode: string | null;
  status_id: string;
  is_open: boolean;
}

/**
 * The one place that answers "may this person work with this lead?". Everything that hangs off a
 * lead (profile, follow-ups, shortlist, documents) asks here first. A lead that is not theirs is a
 * 404, not a 403, so its existence is not revealed.
 */
@Injectable()
export class LeadAccess {
  /** The lead, if the caller may see it. With `lock`, held still until the transaction ends. */
  async get(trx: Trx, auth: AuthContext, leadId: string, lock = false): Promise<AccessibleLead> {
    const visible = leadVisibility(auth);
    const { rows } = await sql<AccessibleLead>`
      SELECT l.id, l.lead_no::text AS lead_no, l.name, l.primary_phone, l.assigned_to, l.study_mode, l.status_id, s.is_open
      FROM leads l JOIN lead_statuses s ON s.id = l.status_id
      WHERE l.id = ${leadId} AND l.deleted_at IS NULL ${visible ? sql`AND ${visible}` : sql``}
      ${lock ? sql`FOR UPDATE OF l` : sql``}`.execute(trx);
    if (!rows[0]) throw AppError.notFound('Lead');
    return rows[0];
  }
}
