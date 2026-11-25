import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { scopeCondition, andIf } from '../access/scope.js';
import { AuditService } from '../audit/audit.service.js';
import { AppError } from '../common/app-error.js';
import { DatabaseService, Trx } from '../database/database.service.js';
import type { AuthContext } from './auth-context.js';
import { distanceMeters } from './office-rules.js';

/** How long a request waits for an answer before it expires. */
export const REQUEST_MINUTES = 10;
/** Office refusals that approval cannot stand in for: the office is not set up, or the person is at the office on a computer awaiting its own approval. */
const NOT_FOR_APPROVAL = new Set(['not_configured', 'computer']);

export const canAskForApproval = (officeReason: string): boolean =>
  !NOT_FOR_APPROVAL.has(officeReason);

const newPollToken = (): string => randomBytes(24).toString('base64url');
const hashPollToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export interface RemoteSigninView {
  id: string;
  user: { id: string; name: string };
  state: 'pending' | 'approved' | 'rejected' | 'expired';
  reason: string;
  officeReason: string | null;
  distanceM: number | null;
  ip: string | null;
  decidedBy: string | null;
  expiresAt: Date;
  createdAt: Date;
}

interface Row {
  id: string;
  user_id: string;
  user_name: string;
  state: RemoteSigninView['state'];
  reason: string;
  office_reason: string | null;
  distance_m: number | null;
  ip: string | null;
  decider: string | null;
  expires_at: Date;
  created_at: Date;
}
/** One request as the approvers see it (add the WHERE). */
const VIEW_SELECT = sql`
  SELECT r.id, r.user_id, u.name AS user_name, r.state, r.reason, r.office_reason, r.distance_m, host(r.ip) AS ip,
         d.name AS decider, r.expires_at, r.created_at
  FROM remote_signin_requests r JOIN users u ON u.id = r.user_id LEFT JOIN users d ON d.id = r.decided_by`;

/** A request nobody answered in time is expired (for one person, one request, or all). */
const expirePending = (trx: Trx, where: ReturnType<typeof sql>) =>
  sql`UPDATE remote_signin_requests SET state = 'expired' WHERE state = 'pending' AND expires_at <= now() AND ${where}`.execute(
    trx,
  );

const toView = (r: Row): RemoteSigninView => ({
  id: r.id,
  user: { id: r.user_id, name: r.user_name },
  state: r.state,
  reason: r.reason,
  officeReason: r.office_reason,
  distanceM: r.distance_m,
  ip: r.ip,
  decidedBy: r.decider,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
});

/**
 * Approval to sign in from outside the office for one day (see migration 059). The sign-in itself stays the normal one: a person
 * with an approval for today simply passes the office check; everything else (password, two-step code, session, attendance) is
 * exactly as at the office.
 */
@Injectable()
export class RemoteSigninService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ at sign-in (inside the sign-in transaction)

  /** The approval this person has for today, if any. */
  async approvedToday(trx: Trx, userId: string): Promise<string | null> {
    const { rows } = await sql<{ id: string }>`
      SELECT r.id FROM remote_signin_requests r, tenants t
      WHERE r.user_id = ${userId} AND r.state = 'approved' AND r.work_date = (now() AT TIME ZONE t.timezone)::date
      ORDER BY r.decided_at DESC LIMIT 1`.execute(trx);
    return rows[0]?.id ?? null;
  }

  async markUsed(trx: Trx, id: string): Promise<void> {
    await sql`UPDATE remote_signin_requests SET used_at = COALESCE(used_at, now()) WHERE id = ${id}`.execute(
      trx,
    );
  }

  /**
   * Asks for approval. A request already waiting is reused (with a new token for the browser that asks now), so pressing the
   * button twice does not tell the approvers twice. Returns the request, its token, and whether it is new.
   */
  async request(
    trx: Trx,
    a: {
      tenantId: string;
      userId: string;
      branchId: string | null;
      reason: string;
      officeReason: string;
      ip: string;
      location?: { lat: number; lng: number; accuracy?: number };
    },
  ): Promise<{
    id: string;
    pollToken: string;
    created: boolean;
    distanceM: number | null;
    expiresAt: Date;
  }> {
    await expirePending(trx, sql`user_id = ${a.userId}`);
    const token = newPollToken();
    const hash = hashPollToken(token);
    const { rows: waiting } = await sql<{
      id: string;
      distance_m: number | null;
      expires_at: Date;
    }>`
      UPDATE remote_signin_requests SET poll_hash = ${hash}, reason = ${a.reason}
      WHERE id = (SELECT id FROM remote_signin_requests WHERE user_id = ${a.userId} AND state = 'pending' ORDER BY created_at DESC LIMIT 1)
      RETURNING id, distance_m, expires_at`.execute(trx);
    if (waiting[0])
      return {
        id: waiting[0].id,
        pollToken: token,
        created: false,
        distanceM: waiting[0].distance_m,
        expiresAt: waiting[0].expires_at,
      };

    let distanceM: number | null = null;
    if (a.location && a.branchId) {
      const { rows } = await sql<{
        latitude: string | null;
        longitude: string | null;
      }>`SELECT latitude, longitude FROM branches WHERE id = ${a.branchId}`.execute(trx);
      const b = rows[0];
      if (b?.latitude != null && b.longitude != null)
        distanceM = Math.round(
          distanceMeters({ lat: Number(b.latitude), lng: Number(b.longitude) }, a.location),
        );
    }
    const { rows } = await sql<{ id: string; expires_at: Date }>`
      INSERT INTO remote_signin_requests (tenant_id, user_id, reason, office_reason, ip, lat, lng, accuracy_m, distance_m, poll_hash, expires_at, work_date)
      SELECT ${a.tenantId}, ${a.userId}, ${a.reason}, ${a.officeReason}, ${a.ip}::inet, ${a.location?.lat ?? null}, ${a.location?.lng ?? null},
             ${a.location?.accuracy != null ? Math.round(a.location.accuracy) : null}, ${distanceM}, ${hash},
             now() + make_interval(mins => ${REQUEST_MINUTES}), (now() AT TIME ZONE t.timezone)::date
      FROM tenants t
      RETURNING id, expires_at`.execute(trx);
    return {
      id: rows[0]!.id,
      pollToken: token,
      created: true,
      distanceM,
      expiresAt: rows[0]!.expires_at,
    };
  }

  // ------------------------------------------------------------------ for the waiting browser (no sign-in yet)

  /** How a request stands, for the browser that holds its token. Anything else is "not found". */
  async status(
    trx: Trx,
    id: string,
    token: string,
  ): Promise<{ state: RemoteSigninView['state']; decidedBy: string | null }> {
    await expirePending(trx, sql`id = ${id}`);
    const { rows } = await sql<{
      state: RemoteSigninView['state'];
      decider: string | null;
      poll_hash: string;
    }>`
      SELECT r.state, d.name AS decider, r.poll_hash FROM remote_signin_requests r LEFT JOIN users d ON d.id = r.decided_by WHERE r.id = ${id}`.execute(
      trx,
    );
    const r = rows[0];
    if (!r || r.poll_hash !== hashPollToken(token)) throw AppError.notFound('Request');
    return { state: r.state, decidedBy: r.decider };
  }

  // ------------------------------------------------------------------ for the people who approve

  list(auth: AuthContext, state: 'pending' | 'decided'): Promise<RemoteSigninView[]> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      await expirePending(trx, sql`true`);
      const scoped = scopeCondition(auth, 'r.user_id');
      const { rows } = await sql<Row>`
        ${VIEW_SELECT}
        WHERE ${state === 'pending' ? sql`r.state = 'pending'` : sql`r.state <> 'pending' AND r.created_at > now() - interval '30 days'`}
          ${andIf(scoped)}
        ORDER BY r.created_at DESC LIMIT 100`.execute(trx);
      return rows.map(toView);
    });
  }

  decide(
    auth: AuthContext,
    id: string,
    decision: 'approved' | 'rejected',
  ): Promise<RemoteSigninView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const scoped = scopeCondition(auth, 'r.user_id');
      const { rows } = await sql<{ user_id: string; state: string; expired: boolean }>`
        SELECT r.user_id, r.state, r.expires_at <= now() AS expired FROM remote_signin_requests r
        WHERE r.id = ${id} ${andIf(scoped)} FOR UPDATE OF r`.execute(trx);
      const r = rows[0];
      if (!r) throw AppError.notFound('Request');
      if (r.user_id === auth.userId)
        throw new AppError('SELF_APPROVAL', 'Another person must answer your own request', 403);
      if (r.state === 'pending' && r.expired) {
        await expirePending(trx, sql`id = ${id}`);
        throw new AppError(
          'REQUEST_EXPIRED',
          `This request has expired (requests wait ${REQUEST_MINUTES} minutes). The person can ask again.`,
          409,
        );
      }
      if (r.state !== 'pending')
        throw new AppError(
          'REQUEST_DECIDED',
          r.state === 'expired'
            ? 'This request has expired. The person can ask again.'
            : `This request was already ${r.state}.`,
          409,
        );
      await sql`UPDATE remote_signin_requests SET state = ${decision}, decided_by = ${auth.userId}, decided_at = now() WHERE id = ${id}`.execute(
        trx,
      );
      await this.audit.by(trx, auth, {
        action: decision === 'approved' ? 'remote_signin.approve' : 'remote_signin.reject',
        entity: 'user',
        entityId: r.user_id,
        after: { requestId: id },
      });
      const { rows: view } = await sql<Row>`${VIEW_SELECT} WHERE r.id = ${id}`.execute(trx);
      return toView(view[0]!);
    });
  }
}
