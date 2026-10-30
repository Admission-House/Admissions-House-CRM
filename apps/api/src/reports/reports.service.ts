import { Injectable } from '@nestjs/common';
import { Expression, sql, SqlBool } from 'kysely';
import { leadVisibility } from '../access/lead-scope.js';
import { scopeCondition } from '../access/scope.js';
import { AttendanceSummaryService } from '../attendance/attendance-summary.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppError } from '../common/app-error.js';
import { DatabaseService, Trx } from '../database/database.service.js';
import { LeadsService } from '../leads/leads.service.js';
import { monthStart } from '../payroll/payroll-rules.js';
import type { Report } from './report-file.js';

const MAX_DAYS = 366;
/** A person with no activity for this long, while signed in, is shown as idle. */
const IDLE_AFTER_MIN = 10;

export interface Range {
  from?: string;
  to?: string;
}

const secs = (n: number | string | null | undefined) => Math.round(Number(n ?? 0));
const n = (v: string | undefined) => Number(v ?? 0);
const mins = (n: number | string | null) => (n === null ? null : Math.round(Number(n) * 10) / 10);

/**
 * The reports. Each one respects the caller's data scope: a Counsellor sees their own work, an Admin
 * their team's, a Super Admin everything. Dates are days in the company's time zone and a report
 * covers at most a year, so a careless query cannot read the whole history.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly leads: LeadsService,
    private readonly summary: AttendanceSummaryService,
  ) {}

  // -------------------------------------------------------------- dashboard

  async dashboard(auth: AuthContext) {
    const queues = await this.leads.queues(auth);
    const today = await this.db.withTenant(auth.tenantId, async (trx) => {
      const range = await this.range(trx, {});
      const scoped = scopeCondition(auth, 'c.user_id');
      const { rows } = await sql<{ total: string; connected: string; missed: string; talk: string }>`
        SELECT count(*) AS total, count(*) FILTER (WHERE c.outcome = 'connected') AS connected,
               count(*) FILTER (WHERE c.outcome = 'missed') AS missed, coalesce(sum(c.duration_sec), 0) AS talk
        FROM calls c WHERE c.started_at >= now() - interval '1 day' AND c.started_at >= ${range.todayStart}::timestamptz ${scoped ? sql`AND ${scoped}` : sql``}`.execute(trx);
      const overdue = await sql<{ n: string }>`
        SELECT count(*) AS n FROM followups f JOIN leads l ON l.id = f.lead_id
        WHERE f.done_at IS NULL AND f.due_at < now() AND l.deleted_at IS NULL ${this.vis(auth, 'f.user_id')}`.execute(trx);
      return { calls: { total: Number(rows[0]!.total), connected: Number(rows[0]!.connected), missed: Number(rows[0]!.missed), talkSec: secs(rows[0]!.talk) }, overdueFollowUps: Number(overdue.rows[0]!.n) };
    });
    const byStatus = await this.db.withTenant(auth.tenantId, async (trx) => {
      const v = leadVisibility(auth);
      const { rows } = await sql<{ name: string; n: string }>`
        SELECT s.name, count(*) AS n FROM leads l JOIN lead_statuses s ON s.id = l.status_id
        WHERE l.deleted_at IS NULL ${v ? sql`AND ${v}` : sql``} GROUP BY s.name, s.sort_order ORDER BY s.sort_order`.execute(trx);
      return rows.map((r) => ({ status: r.name, leads: Number(r.n) }));
    });
    const team = auth.dataScope === 'own' ? null : (await this.teamStatus(auth)).rows;
    return { ...queues, byStatus, today, team };
  }

  private vis(auth: AuthContext, column: string) {
    const s = scopeCondition(auth, column);
    return s ? sql`AND ${s}` : sql``;
  }

  // ------------------------------------------------------------ team status

  async teamStatus(auth: AuthContext): Promise<Report> {
    const rows = await this.db.withTenant(auth.tenantId, async (trx) => {
      const scoped = scopeCondition(auth, 'u.id');
      const { rows } = await sql<{ id: string; name: string; role: string; status: string; since: Date | null }>`
        SELECT u.id, u.name, r.name AS role, x.last_active_at AS since,
          CASE
            WHEN x.last_active_at IS NULL THEN 'not_logged_in'
            WHEN EXISTS (SELECT 1 FROM calls c WHERE c.user_id = u.id AND c.ended_at IS NULL
                           AND ((c.outcome = 'connected' AND c.started_at > now() - interval '3 hours')
                             OR (c.outcome IN ('requested', 'ringing') AND c.started_at > now() - interval '2 minutes'))) THEN 'on_call'
            WHEN EXISTS (SELECT 1 FROM break_logs b JOIN attendance_records a ON a.id = b.attendance_id
                          WHERE a.user_id = u.id AND b.ended_at IS NULL AND a.check_out_at IS NULL) THEN 'on_break'
            WHEN x.last_active_at < now() - make_interval(mins => ${IDLE_AFTER_MIN}) THEN 'idle'
            ELSE 'online' END AS status
        FROM users u JOIN roles r ON r.id = u.role_id
        LEFT JOIN LATERAL (SELECT max(last_active_at) AS last_active_at FROM user_sessions s
                           WHERE s.user_id = u.id AND s.ended_at IS NULL AND s.expires_at > now()) x ON true
        WHERE u.status = 'active' ${scoped ? sql`AND ${scoped}` : sql``}
        ORDER BY u.name`.execute(trx);
      return rows;
    });
    return {
      title: 'Team status',
      columns: [{ key: 'name', label: 'Name' }, { key: 'role', label: 'Role' }, { key: 'status', label: 'Status' }, { key: 'lastActive', label: 'Last active' }],
      rows: rows.map((r) => ({ userId: r.id, name: r.name, role: r.role, status: r.status, lastActive: r.since?.toISOString() ?? null })),
    };
  }

  // ------------------------------------------------------------------- TAT

  /** Time from a lead arriving to the first outgoing call, by counsellor or by source. */
  tat(auth: AuthContext, q: Range & { groupBy: 'user' | 'source' }): Promise<Report> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const r = await this.range(trx, q);
      const v = leadVisibility(auth);
      const key = q.groupBy === 'user' ? sql`coalesce(u.name, 'Unassigned')` : sql`src.name`;
      const { rows } = await sql<{ name: string; leads: string; called: string; avg: string | null; median: string | null }>`
        WITH first_call AS (
          SELECT lead_id, min(started_at) AS at FROM calls
          WHERE direction = 'outgoing' AND lead_id IS NOT NULL AND started_at >= ${r.fromTs}::timestamptz GROUP BY lead_id)
        SELECT ${key} AS name, count(*) AS leads, count(fc.at) AS called,
               avg(extract(epoch FROM fc.at - l.created_at) / 60) AS avg,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM fc.at - l.created_at) / 60) AS median
        FROM leads l
        JOIN lead_sources src ON src.id = l.source_id
        LEFT JOIN users u ON u.id = l.assigned_to
        LEFT JOIN first_call fc ON fc.lead_id = l.id AND fc.at >= l.created_at
        WHERE l.deleted_at IS NULL AND l.created_at >= ${r.fromTs}::timestamptz AND l.created_at < ${r.toTs}::timestamptz ${v ? sql`AND ${v}` : sql``}
        GROUP BY 1 ORDER BY 1`.execute(trx);
      return {
        title: `TAT by ${q.groupBy}`, from: r.from, to: r.to,
        columns: [
          { key: 'name', label: q.groupBy === 'user' ? 'Counsellor' : 'Source' }, { key: 'leads', label: 'Leads' }, { key: 'called', label: 'Called' },
          { key: 'notCalled', label: 'Not called yet' }, { key: 'avgMin', label: 'Average minutes to first call' }, { key: 'medianMin', label: 'Median minutes to first call' },
        ],
        rows: rows.map((x) => ({ name: x.name, leads: Number(x.leads), called: Number(x.called), notCalled: Number(x.leads) - Number(x.called), avgMin: mins(x.avg), medianMin: mins(x.median) })),
      };
    });
  }

  // ----------------------------------------------------------- productivity

  /** Calls, talk time, status changes and follow-ups completed, for each person on each day. */
  productivity(auth: AuthContext, q: Range & { userId?: string }): Promise<Report> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const r = await this.range(trx, q);
      const tz = r.tz;
      const who = (col: string): Expression<SqlBool> => {
        const parts = [scopeCondition(auth, col), q.userId ? sql<SqlBool>`${sql.ref(col)} = ${q.userId}::uuid` : undefined].filter(Boolean) as Expression<SqlBool>[];
        return parts.length ? sql<SqlBool>`${sql.join(parts, sql` AND `)}` : sql<SqlBool>`true`;
      };
      const { rows } = await sql<{ name: string; day: string; calls: string; connected: string; talk: string; changes: string; followups: string }>`
        WITH m AS (
          SELECT c.user_id, (c.started_at AT TIME ZONE ${tz})::date AS day, 1 AS calls, (c.outcome = 'connected')::int AS connected, coalesce(c.duration_sec, 0) AS talk, 0 AS changes, 0 AS followups
          FROM calls c WHERE c.user_id IS NOT NULL AND c.started_at >= ${r.fromTs}::timestamptz AND c.started_at < ${r.toTs}::timestamptz AND ${who('c.user_id')}
          UNION ALL
          SELECT a.user_id, (a.created_at AT TIME ZONE ${tz})::date, 0, 0, 0, 1, 0
          FROM lead_activities a WHERE a.type = 'status_change' AND a.user_id IS NOT NULL AND a.created_at >= ${r.fromTs}::timestamptz AND a.created_at < ${r.toTs}::timestamptz AND ${who('a.user_id')}
          UNION ALL
          SELECT f.user_id, (f.done_at AT TIME ZONE ${tz})::date, 0, 0, 0, 0, 1
          FROM followups f WHERE f.done_at >= ${r.fromTs}::timestamptz AND f.done_at < ${r.toTs}::timestamptz AND ${who('f.user_id')})
        SELECT u.name, m.day::text AS day, sum(calls) AS calls, sum(connected) AS connected, sum(talk) AS talk, sum(changes) AS changes, sum(followups) AS followups
        FROM m JOIN users u ON u.id = m.user_id GROUP BY u.name, m.day ORDER BY m.day DESC, u.name`.execute(trx);
      return {
        title: 'Agent productivity', from: r.from, to: r.to,
        columns: [
          { key: 'day', label: 'Day' }, { key: 'name', label: 'Counsellor' }, { key: 'calls', label: 'Calls' }, { key: 'connected', label: 'Connected calls' },
          { key: 'talkSec', label: 'Talk time (seconds)' }, { key: 'statusChanges', label: 'Status changes' }, { key: 'followUpsDone', label: 'Follow-ups completed' },
        ],
        rows: rows.map((x) => ({ day: x.day, name: x.name, calls: Number(x.calls), connected: Number(x.connected), talkSec: secs(x.talk), statusChanges: Number(x.changes), followUpsDone: Number(x.followups) })),
      };
    });
  }

  // ------------------------------------------------------------------ leads

  leadsBy(auth: AuthContext, q: Range & { groupBy: 'source' | 'status' | 'assignee' | 'day' }): Promise<Report> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const r = await this.range(trx, q);
      const v = leadVisibility(auth);
      const key = { source: sql`src.name`, status: sql`s.name`, assignee: sql`coalesce(u.name, 'Unassigned')`, day: sql`(l.created_at AT TIME ZONE ${r.tz})::date::text` }[q.groupBy];
      const { rows } = await sql<{ name: string; leads: string; open: string; closed: string; unassigned: string }>`
        SELECT ${key} AS name, count(*) AS leads, count(*) FILTER (WHERE s.is_open) AS open, count(*) FILTER (WHERE NOT s.is_open) AS closed,
               count(*) FILTER (WHERE l.assigned_to IS NULL) AS unassigned
        FROM leads l JOIN lead_statuses s ON s.id = l.status_id JOIN lead_sources src ON src.id = l.source_id LEFT JOIN users u ON u.id = l.assigned_to
        WHERE l.deleted_at IS NULL AND l.created_at >= ${r.fromTs}::timestamptz AND l.created_at < ${r.toTs}::timestamptz ${v ? sql`AND ${v}` : sql``}
        GROUP BY 1 ORDER BY ${q.groupBy === 'day' ? sql`1 DESC` : sql`count(*) DESC, 1`}`.execute(trx);
      const label = { source: 'Source', status: 'Status', assignee: 'Counsellor', day: 'Day' }[q.groupBy];
      return {
        title: `Leads by ${q.groupBy}`, from: r.from, to: r.to,
        columns: [{ key: 'name', label }, { key: 'leads', label: 'Leads' }, { key: 'open', label: 'Open' }, { key: 'closed', label: 'Closed' }, { key: 'unassigned', label: 'Unassigned' }],
        rows: rows.map((x) => ({ name: x.name, leads: Number(x.leads), open: Number(x.open), closed: Number(x.closed), unassigned: Number(x.unassigned) })),
      };
    });
  }

  // --------------------------------------------------------------- activity

  /** How many things each person did on each day: notes, status changes, calls and so on. */
  activity(auth: AuthContext, q: Range & { userId?: string }): Promise<Report> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const r = await this.range(trx, q);
      const scoped = scopeCondition(auth, 'a.user_id');
      const { rows } = await sql<Record<string, string>>`
        SELECT (a.created_at AT TIME ZONE ${r.tz})::date::text AS day, u.name,
               count(*) AS total, count(*) FILTER (WHERE a.type = 'note') AS notes, count(*) FILTER (WHERE a.type = 'status_change') AS status_changes,
               count(*) FILTER (WHERE a.type = 'call') AS calls, count(*) FILTER (WHERE a.type = 'followup') AS followups,
               count(*) FILTER (WHERE a.type = 'document') AS documents, count(*) FILTER (WHERE a.type = 'shortlist') AS shortlists,
               count(*) FILTER (WHERE a.type IN ('assignment', 'field_change', 'enquiry')) AS other
        FROM lead_activities a JOIN users u ON u.id = a.user_id
        WHERE a.created_at >= ${r.fromTs}::timestamptz AND a.created_at < ${r.toTs}::timestamptz ${scoped ? sql`AND ${scoped}` : sql``}
          ${q.userId ? sql`AND a.user_id = ${q.userId}::uuid` : sql``}
        GROUP BY 1, 2 ORDER BY 1 DESC, 2`.execute(trx);
      return {
        title: 'Activity', from: r.from, to: r.to,
        columns: [
          { key: 'day', label: 'Day' }, { key: 'name', label: 'Person' }, { key: 'total', label: 'Total' }, { key: 'notes', label: 'Notes' }, { key: 'statusChanges', label: 'Status changes' },
          { key: 'calls', label: 'Calls' }, { key: 'followups', label: 'Follow-ups' }, { key: 'documents', label: 'Documents' }, { key: 'shortlists', label: 'Shortlists' }, { key: 'other', label: 'Other' },
        ],
        rows: rows.map((x) => ({
          day: x.day!, name: x.name!, total: Number(x.total), notes: Number(x.notes), statusChanges: Number(x.status_changes), calls: Number(x.calls),
          followups: Number(x.followups), documents: Number(x.documents), shortlists: Number(x.shortlists), other: Number(x.other),
        })),
      };
    });
  }

  // ------------------------------------------------------------------ calls

  calls(auth: AuthContext, q: Range): Promise<Report> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const r = await this.range(trx, q);
      const scoped = scopeCondition(auth, 'c.user_id');
      const { rows } = await sql<Record<string, string>>`
        SELECT coalesce(u.name, 'Unknown') AS name, count(*) AS total, count(*) FILTER (WHERE c.direction = 'outgoing') AS outgoing,
               count(*) FILTER (WHERE c.direction = 'incoming') AS incoming, count(*) FILTER (WHERE c.outcome = 'connected') AS connected,
               count(*) FILTER (WHERE c.outcome = 'missed') AS missed, coalesce(sum(c.duration_sec), 0) AS talk,
               avg(c.duration_sec) FILTER (WHERE c.outcome = 'connected') AS avg_secs
        FROM calls c LEFT JOIN users u ON u.id = c.user_id
        WHERE c.started_at >= ${r.fromTs}::timestamptz AND c.started_at < ${r.toTs}::timestamptz ${scoped ? sql`AND ${scoped}` : sql``}
        GROUP BY 1 ORDER BY 1`.execute(trx);
      return {
        title: 'Call activity', from: r.from, to: r.to,
        columns: [
          { key: 'name', label: 'Counsellor' }, { key: 'total', label: 'Calls' }, { key: 'outgoing', label: 'Outgoing' }, { key: 'incoming', label: 'Incoming' },
          { key: 'connected', label: 'Connected' }, { key: 'missed', label: 'Missed' }, { key: 'talkSec', label: 'Talk time (seconds)' }, { key: 'avgSec', label: 'Average connected call (seconds)' },
        ],
        rows: rows.map((x) => ({ name: x.name!, total: n(x.total), outgoing: n(x.outgoing), incoming: n(x.incoming), connected: n(x.connected), missed: n(x.missed), talkSec: secs(x.talk), avgSec: x.avg_secs === null ? null : secs(x.avg_secs) })),
      };
    });
  }

  // ------------------------------------------------------------- attendance

  /** Present, late, on leave and absent for every person in reach, for one month. */
  attendance(auth: AuthContext, q: { month: string }): Promise<Report> {
    const month = monthStart(q.month);
    if (!month) throw AppError.badRequest('MONTH_INVALID', 'Give the month as YYYY-MM', [{ field: 'month', message: 'Give the month as YYYY-MM' }]);
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const scoped = scopeCondition(auth, 'u.id');
      const { rows: people } = await sql<{ id: string; name: string; role: string }>`
        SELECT u.id, u.name, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.status = 'active' AND r.requires_office ${scoped ? sql`AND ${scoped}` : sql``} ORDER BY u.name`.execute(trx);
      const sums = await this.summary.forMonth(trx, people.map((p) => p.id), month);
      return {
        title: 'Attendance summary', from: month, to: month,
        columns: [
          { key: 'name', label: 'Name' }, { key: 'role', label: 'Role' }, { key: 'workingDays', label: 'Working days' }, { key: 'present', label: 'Present' },
          { key: 'late', label: 'Late days' }, { key: 'lateMinutes', label: 'Late minutes' }, { key: 'leaveDays', label: 'On leave' }, { key: 'absent', label: 'Absent' },
        ],
        rows: people.map((p) => {
          const s = sums.get(p.id);
          return { name: p.name, role: p.role, workingDays: s?.workingDays ?? 0, present: s?.present ?? 0, late: s?.late ?? 0, lateMinutes: s?.lateMinutes ?? 0, leaveDays: s?.leaveDays ?? 0, absent: s?.absent ?? 0 };
        }),
      };
    });
  }

  /**
   * Who was in on each day of a month. One row per person, one column per day, with a letter:
   * P present, L present but late, V on approved leave, O weekly off or holiday, A absent. Days
   * that have not happened yet are left empty.
   */
  attendanceDays(auth: AuthContext, q: { month: string }): Promise<Report> {
    const month = monthStart(q.month);
    if (!month) throw AppError.badRequest('MONTH_INVALID', 'Give the month as YYYY-MM', [{ field: 'month', message: 'Give the month as YYYY-MM' }]);
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const scoped = scopeCondition(auth, 'u.id');
      const { rows: people } = await sql<{ id: string; name: string; role: string }>`
        SELECT u.id, u.name, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.status = 'active' AND r.requires_office ${scoped ? sql`AND ${scoped}` : sql``} ORDER BY u.name`.execute(trx);
      const ids = people.map((p) => p.id);

      const { rows: days } = await sql<{ day: string; off: boolean; future: boolean }>`
        SELECT d::date::text AS day,
               (extract(dow FROM d::date)::smallint = ANY (coalesce((SELECT weekly_off_days FROM attendance_settings WHERE effective_from <= d::date ORDER BY effective_from DESC LIMIT 1), '{0}'::smallint[]))
                 OR EXISTS (SELECT 1 FROM holidays h WHERE h.holiday_date = d::date)) AS off,
               d::date > (now() AT TIME ZONE (SELECT timezone FROM tenants LIMIT 1))::date AS future
        FROM generate_series(${month}::date, (${month}::date + interval '1 month - 1 day')::date, interval '1 day') d ORDER BY d`.execute(trx);

      const { rows: marks } = await sql<{ user_id: string; day: string; late: number }>`
        SELECT user_id, work_date::text AS day, late_minutes AS late FROM attendance_records
        WHERE user_id = ANY(${ids}::uuid[]) AND work_date BETWEEN ${month}::date AND (${month}::date + interval '1 month - 1 day')::date`.execute(trx);
      const { rows: leaves } = await sql<{ user_id: string; from_date: string; to_date: string }>`
        SELECT user_id, from_date::text, to_date::text FROM leave_requests
        WHERE user_id = ANY(${ids}::uuid[]) AND status = 'approved' AND from_date <= (${month}::date + interval '1 month - 1 day')::date AND to_date >= ${month}::date`.execute(trx);

      const present = new Map(marks.map((m) => [`${m.user_id}|${m.day}`, m.late]));
      const label = (day: string) => String(Number(day.slice(8)));
      return {
        title: 'Attendance by day', from: month, to: month,
        columns: [{ key: 'name', label: 'Name' }, { key: 'role', label: 'Role' }, ...days.map((d) => ({ key: `d${label(d.day)}`, label: label(d.day) }))],
        rows: people.map((p) => {
          const row: Record<string, string | number | null> = { name: p.name, role: p.role };
          for (const d of days) {
            const late = present.get(`${p.id}|${d.day}`);
            const onLeave = leaves.some((l) => l.user_id === p.id && l.from_date <= d.day && l.to_date >= d.day);
            row[`d${label(d.day)}`] = late !== undefined ? (late > 0 ? 'L' : 'P') : d.future ? '' : d.off ? 'O' : onLeave ? 'V' : 'A';
          }
          return row;
        }),
      };
    });
  }

  // ------------------------------------------------------------------ range

  /** Turns optional dates into exact bounds in the company's time zone. Default: the last 30 days. */
  private async range(trx: Trx, q: Range) {
    const { rows } = await sql<{ tz: string; today: string; todayStart: string }>`
      SELECT timezone AS tz, (now() AT TIME ZONE timezone)::date::text AS today, ((now() AT TIME ZONE timezone)::date::timestamp AT TIME ZONE timezone)::text AS "todayStart" FROM tenants LIMIT 1`.execute(trx);
    const { tz, today, todayStart } = rows[0]!;
    const to = q.to ?? today;
    const from = q.from ?? new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
    if (from > to) throw AppError.badRequest('RANGE_INVALID', 'The start date is after the end date', [{ field: 'from', message: 'Must not be after the end date' }]);
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 >= MAX_DAYS) throw AppError.badRequest('RANGE_TOO_LONG', `Choose at most ${MAX_DAYS} days at a time`, [{ field: 'from', message: `At most ${MAX_DAYS} days` }]);
    const bounds = await sql<{ f: string; t: string }>`
      SELECT (${from}::date::timestamp AT TIME ZONE ${tz})::text AS f, ((${to}::date + 1)::timestamp AT TIME ZONE ${tz})::text AS t`.execute(trx);
    return { tz, from, to, fromTs: bounds.rows[0]!.f, toTs: bounds.rows[0]!.t, todayStart };
  }
}
