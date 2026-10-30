import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Trx } from '../database/database.service.js';
import { Candidate, firstMatchingRule, LeadFacts, pickAssignee, RuleLike } from './intake-rules.js';

export interface Assignment {
  userId: string | null;
  ruleId: string | null;
  /** Why nobody was chosen, when nobody was. */
  reason: 'assigned' | 'no_one_present' | 'auto_assign_off';
}

interface RuleRow {
  id: string;
  priority: number;
  source_id: string | null;
  course_id: string | null;
  location_id: string | null;
  study_mode: 'online' | 'regular' | null;
  strategy: RuleLike['strategy'];
  users: string[];
}

/**
 * Chooses who gets a new lead.
 *
 * Only people who are working right now can be chosen: checked in today and not yet checked
 * out, not on approved leave, and not on a break. The first assignment rule that matches the lead decides who is
 * in the pool and how to choose; with no matching rule the pool is every active counsellor and the
 * choice is round robin. Nobody present means the lead stays unassigned for an Admin to hand out.
 */
@Injectable()
export class AssignmentService {
  async choose(trx: Trx, tenantId: string, lead: LeadFacts): Promise<Assignment> {
    // Two leads arriving together must not both read the same "who is next". The lock lasts until
    // the caller's transaction ends, which is after the lead is saved with its new assignee.
    await sql`SELECT pg_advisory_xact_lock(hashtext('lead-assign'), hashtext(${tenantId}))`.execute(trx);

    const rules = await this.rules(trx);
    const rule = firstMatchingRule(rules, lead);
    const pool = rule && rule.users.length > 0 ? rule.users : null;

    const candidates = await this.presentCandidates(trx, pool);
    const userId = pickAssignee(candidates, rule?.strategy ?? 'round_robin');
    return { userId, ruleId: rule?.id ?? null, reason: userId ? 'assigned' : 'no_one_present' };
  }

  private async rules(trx: Trx): Promise<(RuleLike & { users: string[] })[]> {
    const { rows } = await sql<RuleRow>`
      SELECT r.id, r.priority, r.source_id, r.course_id, r.location_id, r.study_mode, r.strategy,
             COALESCE(array_agg(ru.user_id) FILTER (WHERE ru.user_id IS NOT NULL), '{}') AS users
      FROM assignment_rules r
      LEFT JOIN assignment_rule_users ru ON ru.rule_id = r.id
      WHERE r.is_active
      GROUP BY r.id`.execute(trx);
    return rows.map((r) => ({
      id: r.id, priority: r.priority, sourceId: r.source_id, courseId: r.course_id, locationId: r.location_id,
      studyMode: r.study_mode, strategy: r.strategy, users: r.users,
    }));
  }

  /** Counsellors (limited to `pool` if given) who are in the office now. */
  private async presentCandidates(trx: Trx, pool: string[] | null): Promise<Candidate[]> {
    const { rows } = await sql<{ id: string; last_assigned_at: Date | null; open_leads: string }>`
      SELECT u.id,
             (SELECT max(l.assigned_at) FROM leads l WHERE l.assigned_to = u.id AND l.deleted_at IS NULL) AS last_assigned_at,
             (SELECT count(*) FROM leads l JOIN lead_statuses s ON s.id = l.status_id
              WHERE l.assigned_to = u.id AND l.deleted_at IS NULL AND s.is_open) AS open_leads
      FROM users u
      JOIN roles r ON r.id = u.role_id
      WHERE u.status = 'active'
        AND r.system_key = 'counsellor'
        AND (${pool}::uuid[] IS NULL OR u.id = ANY(${pool}::uuid[]))
        AND EXISTS (
          SELECT 1 FROM attendance_records a, tenants t
          WHERE a.user_id = u.id AND a.work_date = (now() AT TIME ZONE t.timezone)::date AND a.check_out_at IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM leave_requests lr, tenants t
          WHERE lr.user_id = u.id AND lr.status = 'approved'
            AND (now() AT TIME ZONE t.timezone)::date BETWEEN lr.from_date AND lr.to_date)
        AND NOT EXISTS (
          SELECT 1 FROM break_logs b JOIN attendance_records a ON a.id = b.attendance_id
          WHERE a.user_id = u.id AND b.ended_at IS NULL)`.execute(trx);
    return rows.map((r) => ({ userId: r.id, lastAssignedAt: r.last_assigned_at, openLeads: Number(r.open_leads) }));
  }
}
