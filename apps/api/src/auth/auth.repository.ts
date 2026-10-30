import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Trx } from '../database/database.service.js';
import type { DataScope, RoleKey } from './auth-context.js';

export type AttemptResult =
  | 'success'
  | 'bad_password'
  | 'outside_office'
  | 'device_blocked'
  | 'locked'
  | 'inactive';

export type SessionEndReason = 'logout' | 'inactivity' | 'revoked' | 'expired' | 'reuse_detected';

export interface LoginUser {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  status: string;
  branch_id: string | null;
  must_change_password: boolean;
  locked: boolean;
  role_id: string;
  role_name: string;
  role_key: RoleKey | null;
  requires_office: boolean;
}

export interface SessionRow {
  session_id: string;
  user_id: string;
  ended: boolean;
  expired: boolean;
  idle_seconds: number;
  idle_limit_min: number;
  user_status: string;
  tenant_status: string;
  name: string;
  email: string;
  must_change_password: boolean;
  role_id: string;
  role_key: RoleKey | null;
  data_scope: DataScope;
  requires_office: boolean;
  permissions: string[];
}

export interface RefreshRow {
  id: string;
  user_id: string;
  refresh_token_hash: string;
  prev_refresh_token_hash: string | null;
  client_type: string;
  ended: boolean;
  expired: boolean;
  idle_seconds: number;
  idle_limit_min: number;
  user_status: string;
  tenant_status: string;
}

/** Idle limit used when a company has no attendance settings yet. */
const DEFAULT_IDLE_MIN = 30;

/** Every query of the auth module, so the services read as decisions rather than SQL. */
@Injectable()
export class AuthRepository {
  async findLoginUser(trx: Trx, email: string): Promise<LoginUser | undefined> {
    const row = await trx
      .selectFrom('users as u')
      .innerJoin('roles as r', (j) => j.onRef('r.id', '=', 'u.role_id').onRef('r.tenant_id', '=', 'u.tenant_id'))
      .select([
        'u.id',
        'u.name',
        'u.email',
        'u.password_hash',
        'u.status',
        'u.branch_id',
        'u.must_change_password',
        'u.role_id',
        'r.name as role_name',
        'r.system_key as role_key',
        'r.requires_office',
        sql<boolean>`(u.locked_until IS NOT NULL AND u.locked_until > now())`.as('locked'),
      ])
      .where('u.email', '=', email)
      .executeTakeFirst();
    return row as LoginUser | undefined;
  }

  /** Number of sign-in attempts from one address in the last ten minutes. */
  async countRecentAttemptsFromIp(trx: Trx, ip: string): Promise<number> {
    const row = await trx
      .selectFrom('login_attempts')
      .select(sql<string>`count(*)`.as('n'))
      .where('ip', '=', ip)
      .where('created_at', '>', sql<Date>`now() - interval '10 minutes'`)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  async recordAttempt(
    trx: Trx,
    a: { tenantId: string; userId: string | null; result: AttemptResult; ip: string; lat?: number; lng?: number },
  ): Promise<void> {
    await trx
      .insertInto('login_attempts')
      .values({
        tenant_id: a.tenantId,
        user_id: a.userId,
        result: a.result,
        ip: a.ip,
        latitude: a.lat ?? null,
        longitude: a.lng ?? null,
      })
      .execute();
  }

  /**
   * Counts a wrong password and locks the account once the limit is reached. If an earlier lock
   * has run out, counting starts again from one rather than locking on the first mistake.
   */
  async registerFailure(trx: Trx, userId: string, maxFailures: number, lockMinutes: number): Promise<void> {
    await sql`
      UPDATE users SET
        failed_logins = next.n,
        locked_until  = CASE WHEN next.n >= ${maxFailures}
                             THEN now() + make_interval(mins => ${lockMinutes}) ELSE NULL END
      FROM (
        SELECT CASE WHEN locked_until IS NOT NULL AND locked_until <= now() THEN 1 ELSE failed_logins + 1 END AS n
        FROM users WHERE id = ${userId}
      ) AS next
      WHERE users.id = ${userId}`.execute(trx);
  }

  async registerSuccess(trx: Trx, userId: string): Promise<void> {
    await trx
      .updateTable('users')
      .set({ failed_logins: 0, locked_until: null, last_login_at: sql`now()` })
      .where('id', '=', userId)
      .execute();
  }

  async newId(trx: Trx): Promise<string> {
    const { rows } = await sql<{ id: string }>`SELECT uuidv7() AS id`.execute(trx);
    return rows[0]!.id;
  }

  async createSession(
    trx: Trx,
    s: {
      id: string;
      tenantId: string;
      userId: string;
      deviceId: string | null;
      refreshHash: string;
      ip: string;
      userAgent: string | null;
      clientType: 'web' | 'mobile';
      maxHours: number;
    },
  ): Promise<void> {
    await trx
      .insertInto('user_sessions')
      .values({
        id: s.id,
        tenant_id: s.tenantId,
        user_id: s.userId,
        device_id: s.deviceId,
        refresh_token_hash: s.refreshHash,
        ip: s.ip,
        user_agent: s.userAgent,
        client_type: s.clientType,
        expires_at: sql`now() + make_interval(hours => ${s.maxHours})`,
      })
      .execute();
  }

  /** The registered device, created (waiting for approval) the first time it is seen. */
  async findOrCreateDevice(
    trx: Trx,
    d: { tenantId: string; userId: string; fingerprint: string; platform: 'android' | 'ios'; label?: string },
  ): Promise<{ id: string; approved: boolean }> {
    const row = await trx
      .insertInto('user_devices')
      .values({
        tenant_id: d.tenantId,
        user_id: d.userId,
        device_fingerprint: d.fingerprint,
        platform: d.platform,
        label: d.label ?? null,
      })
      .onConflict((oc) => oc.columns(['user_id', 'device_fingerprint']).doUpdateSet({ platform: d.platform }))
      .returning(['id', 'approved_at'])
      .executeTakeFirstOrThrow();
    return { id: row.id, approved: row.approved_at !== null };
  }

  /** Branch position and whether the request came from one of its allowed networks. */
  async officeFacts(
    trx: Trx,
    branchId: string,
    ip: string,
    wifiId: string | undefined,
  ): Promise<{
    branch: { latitude: string | null; longitude: string | null; radius_m: number; is_active: boolean } | undefined;
    hasNetworks: boolean;
    networkMatches: boolean;
  }> {
    const branch = await trx
      .selectFrom('branches')
      .select(['latitude', 'longitude', 'radius_m', 'is_active'])
      .where('id', '=', branchId)
      .executeTakeFirst();
    const networks = await trx
      .selectFrom('branch_networks')
      .select([
        sql<string>`count(*)`.as('total'),
        sql<boolean>`COALESCE(bool_or(
          (kind = 'ip_range' AND ${ip}::inet <<= ip_range) OR
          (kind = 'wifi' AND ${wifiId ?? null}::text IS NOT NULL AND wifi_id = ${wifiId ?? null}::text)
        ), false)`.as('matches'),
      ])
      .where('branch_id', '=', branchId)
      .executeTakeFirstOrThrow();
    return {
      branch: branch as never,
      hasNetworks: Number(networks.total) > 0,
      networkMatches: networks.matches,
    };
  }

  /** Everything the guard needs about a session in one query. */
  async findSession(trx: Trx, sessionId: string, userId: string): Promise<SessionRow | undefined> {
    const { rows } = await sql<SessionRow>`
      SELECT s.id AS session_id, s.user_id,
             (s.ended_at IS NOT NULL) AS ended,
             (s.expires_at <= now()) AS expired,
             EXTRACT(EPOCH FROM now() - s.last_active_at)::float8 AS idle_seconds,
             COALESCE((SELECT a.idle_timeout_min FROM attendance_settings a
                       WHERE a.tenant_id = s.tenant_id
                         AND a.effective_from <= (now() AT TIME ZONE t.timezone)::date
                       ORDER BY a.effective_from DESC LIMIT 1), ${DEFAULT_IDLE_MIN}) AS idle_limit_min,
             u.status AS user_status, t.status AS tenant_status,
             u.name, u.email, u.must_change_password, u.role_id,
             r.system_key AS role_key, r.data_scope, r.requires_office,
             COALESCE((SELECT array_agg(p.code ORDER BY p.code)
                       FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
                       WHERE rp.role_id = r.id AND rp.tenant_id = r.tenant_id), '{}') AS permissions
      FROM user_sessions s
      JOIN users u   ON u.id = s.user_id AND u.tenant_id = s.tenant_id
      JOIN roles r   ON r.id = u.role_id AND r.tenant_id = u.tenant_id
      JOIN tenants t ON t.id = s.tenant_id
      WHERE s.id = ${sessionId} AND s.user_id = ${userId}`.execute(trx);
    return rows[0];
  }

  /** Records activity, at most once every 30 seconds per session, so reads do not become writes. */
  async touchSession(trx: Trx, sessionId: string): Promise<void> {
    await sql`
      UPDATE user_sessions SET last_active_at = now()
      WHERE id = ${sessionId} AND ended_at IS NULL AND last_active_at < now() - interval '30 seconds'`.execute(trx);
  }

  async endSession(trx: Trx, sessionId: string, reason: SessionEndReason): Promise<void> {
    await sql`
      UPDATE user_sessions SET ended_at = now(), ended_reason = ${reason}
      WHERE id = ${sessionId} AND ended_at IS NULL`.execute(trx);
  }

  /** Ends every other live session of a user. Returns how many were ended. */
  async endOtherSessions(trx: Trx, userId: string, keepSessionId: string, reason: SessionEndReason): Promise<number> {
    const result = await sql`
      UPDATE user_sessions SET ended_at = now(), ended_reason = ${reason}
      WHERE user_id = ${userId} AND id <> ${keepSessionId} AND ended_at IS NULL`.execute(trx);
    return Number(result.numAffectedRows ?? 0);
  }

  /** Ends every live session of a user. Returns how many were ended. */
  async endAllSessions(trx: Trx, userId: string, reason: SessionEndReason): Promise<number> {
    const result = await sql`
      UPDATE user_sessions SET ended_at = now(), ended_reason = ${reason}
      WHERE user_id = ${userId} AND ended_at IS NULL`.execute(trx);
    return Number(result.numAffectedRows ?? 0);
  }

  /** Locks the session row so two refreshes of the same session cannot run at once. */
  async lockSessionForRefresh(trx: Trx, sessionId: string): Promise<RefreshRow | undefined> {
    const { rows } = await sql<RefreshRow>`
      SELECT s.id, s.user_id, s.refresh_token_hash, s.prev_refresh_token_hash, s.client_type,
             (s.ended_at IS NOT NULL) AS ended,
             (s.expires_at <= now()) AS expired,
             EXTRACT(EPOCH FROM now() - s.last_active_at)::float8 AS idle_seconds,
             COALESCE((SELECT a.idle_timeout_min FROM attendance_settings a
                       WHERE a.tenant_id = s.tenant_id
                         AND a.effective_from <= (now() AT TIME ZONE t.timezone)::date
                       ORDER BY a.effective_from DESC LIMIT 1), ${DEFAULT_IDLE_MIN}) AS idle_limit_min,
             u.status AS user_status, t.status AS tenant_status
      FROM user_sessions s
      JOIN users u   ON u.id = s.user_id AND u.tenant_id = s.tenant_id
      JOIN tenants t ON t.id = s.tenant_id
      WHERE s.id = ${sessionId}
      FOR UPDATE OF s`.execute(trx);
    return rows[0];
  }

  async rotateRefreshToken(trx: Trx, sessionId: string, oldHash: string, newHash: string): Promise<void> {
    await sql`
      UPDATE user_sessions
      SET prev_refresh_token_hash = ${oldHash}, refresh_token_hash = ${newHash}, last_active_at = now()
      WHERE id = ${sessionId}`.execute(trx);
  }

  async listActiveSessions(trx: Trx, userId: string) {
    return trx
      .selectFrom('user_sessions')
      .select(['id', 'client_type', 'ip', 'user_agent', 'created_at', 'last_active_at'])
      .where('user_id', '=', userId)
      .where('ended_at', 'is', null)
      .where('expires_at', '>', sql<Date>`now()`)
      .orderBy('last_active_at', 'desc')
      .execute();
  }

  async changePassword(trx: Trx, userId: string, hash: string): Promise<void> {
    await trx
      .updateTable('users')
      .set({ password_hash: hash, must_change_password: false, password_changed_at: sql`now()` })
      .where('id', '=', userId)
      .execute();
  }

  async findPasswordHash(trx: Trx, userId: string): Promise<string | undefined> {
    const row = await trx.selectFrom('users').select('password_hash').where('id', '=', userId).executeTakeFirst();
    return row?.password_hash;
  }

  async companyProfile(trx: Trx): Promise<{ name: string; settings: unknown }> {
    return trx.selectFrom('tenants').select(['name', 'settings']).executeTakeFirstOrThrow();
  }
}
