import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { scopeCondition } from '../access/scope.js';
import type { AuthContext } from '../auth/auth-context.js';
import { distanceMeters } from '../auth/office-rules.js';
import { AppError } from '../common/app-error.js';
import { DatabaseService } from '../database/database.service.js';

export interface LocationEntry {
  kind: 'signed_in' | 'refused';
  at: Date;
  user: { id: string; name: string } | null;
  ip: string | null;
  position: { lat: number; lng: number; accuracy: number | null } | null;
  /** Why a sign-in was refused. */
  result: string | null;
  branch: { id: string; name: string } | null;
  /** Metres between the reported position and the office, when both are known. */
  distanceM: number | null;
}

export interface LocationQuery {
  from?: string;
  to?: string;
  userId?: string;
  kind?: 'signed_in' | 'refused';
  limit: number;
}

interface Row {
  kind: LocationEntry['kind']; at: Date; user_id: string | null; user_name: string | null; ip: string | null; lat: string | null; lng: string | null;
  accuracy: string | null; result: string | null; branch_id: string | null; branch_name: string | null; b_lat: string | null; b_lng: string | null;
}

const MAX_DAYS = 62;

/**
 * Where people signed in from, and who was turned away. It combines the check-ins (position and
 * address the office check accepted) with the refused attempts, so an Admin can see odd patterns.
 * Each person is seen only by someone whose data scope covers them.
 */
@Injectable()
export class LocationLogService {
  constructor(private readonly db: DatabaseService) {}

  list(auth: AuthContext, q: LocationQuery): Promise<LocationEntry[]> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const { rows: t } = await sql<{ tz: string; today: string }>`SELECT timezone AS tz, (now() AT TIME ZONE timezone)::date::text AS today FROM tenants LIMIT 1`.execute(trx);
      const { tz, today } = t[0]!;
      const to = q.to ?? today;
      const from = q.from ?? new Date(Date.parse(`${to}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
      if (from > to) throw AppError.badRequest('RANGE_INVALID', 'The start date is after the end date', [{ field: 'from', message: 'Must not be after the end date' }]);
      if ((Date.parse(to) - Date.parse(from)) / 86_400_000 >= MAX_DAYS) throw AppError.badRequest('RANGE_TOO_LONG', `Choose at most ${MAX_DAYS} days at a time`, [{ field: 'from', message: `At most ${MAX_DAYS} days` }]);

      const lower = sql`(${from}::date::timestamp AT TIME ZONE ${tz})`;
      const upper = sql`((${to}::date + 1)::timestamp AT TIME ZONE ${tz})`;
      const scopeA = scopeCondition(auth, 'a.user_id');
      const scopeL = scopeCondition(auth, 'l.user_id');
      const parts = [];
      if (q.kind !== 'refused') {
        parts.push(sql`
          SELECT 'signed_in'::text AS kind, a.check_in_at AS at, a.user_id, u.name AS user_name, host(a.check_in_ip) AS ip,
                 a.check_in_lat::text AS lat, a.check_in_lng::text AS lng, a.check_in_accuracy_m::text AS accuracy, NULL::text AS result,
                 b.id AS branch_id, b.name AS branch_name, b.latitude::text AS b_lat, b.longitude::text AS b_lng
          FROM attendance_records a JOIN users u ON u.id = a.user_id LEFT JOIN branches b ON b.id = a.branch_id
          WHERE a.check_in_at >= ${lower} AND a.check_in_at < ${upper} AND a.method = 'office_check'
            ${q.userId ? sql`AND a.user_id = ${q.userId}::uuid` : sql``} ${scopeA ? sql`AND ${scopeA}` : sql``}`);
      }
      if (q.kind !== 'signed_in') {
        parts.push(sql`
          SELECT 'refused'::text AS kind, l.created_at AS at, l.user_id, u.name AS user_name, host(l.ip) AS ip,
                 l.latitude::text AS lat, l.longitude::text AS lng, NULL::text AS accuracy, l.result,
                 b.id AS branch_id, b.name AS branch_name, b.latitude::text AS b_lat, b.longitude::text AS b_lng
          FROM login_attempts l JOIN users u ON u.id = l.user_id LEFT JOIN branches b ON b.id = u.branch_id
          WHERE l.result IN ('outside_office', 'device_blocked') AND l.created_at >= ${lower} AND l.created_at < ${upper}
            ${q.userId ? sql`AND l.user_id = ${q.userId}::uuid` : sql``} ${scopeL ? sql`AND ${scopeL}` : sql``}`);
      }
      const { rows } = await sql<Row>`SELECT * FROM (${sql.join(parts, sql` UNION ALL `)}) x ORDER BY at DESC LIMIT ${q.limit}`.execute(trx);

      return rows.map((r) => {
        const pos = r.lat !== null && r.lng !== null ? { lat: Number(r.lat), lng: Number(r.lng), accuracy: r.accuracy === null ? null : Number(r.accuracy) } : null;
        const office = r.b_lat !== null && r.b_lng !== null ? { lat: Number(r.b_lat), lng: Number(r.b_lng) } : null;
        return {
          kind: r.kind, at: r.at, user: r.user_id ? { id: r.user_id, name: r.user_name ?? '' } : null, ip: r.ip, position: pos, result: r.result,
          branch: r.branch_id ? { id: r.branch_id, name: r.branch_name ?? '' } : null,
          distanceM: pos && office ? Math.round(distanceMeters(office, pos)) : null,
        };
      });
    });
  }
}
