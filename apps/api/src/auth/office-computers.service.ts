import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { scopeCondition, andIf } from '../access/scope.js';
import { AuditService } from '../audit/audit.service.js';
import { AppError } from '../common/app-error.js';
import { DatabaseService, Trx } from '../database/database.service.js';
import type { AuthContext } from './auth-context.js';

/** How many registered computers one person may have; past that the one used longest ago is dropped. */
export const MAX_COMPUTERS = 5;
/** A registered computer that has not signed in for this many days is no longer trusted: it asks for approval again. */
export const STALE_DAYS = 90;
/** How many requests for approval one person may have waiting at once. */
const MAX_WAITING = 3;

/** A new random token for a browser. Only its hash is ever stored. */
export const newComputerToken = (): string => randomBytes(32).toString('base64url');
export const COMPUTER_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const hashComputerToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/** A short, readable name for a browser, from what it says about itself (never trusted for anything but a label). */
export function computerLabel(userAgent: string | null | undefined): string {
  const ua = userAgent ?? '';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser';
  const system = /Windows/.test(ua)
    ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua)
      ? 'Mac'
      : /Android/.test(ua)
        ? 'Android'
        : /iPhone|iPad/.test(ua)
          ? 'iPhone or iPad'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'a computer';
  return `${browser} on ${system}`;
}

export interface ComputerView {
  id: string;
  user: { id: string; name: string };
  state: 'pending' | 'approved';
  label: string | null;
  /** The address it last signed in from. */
  lastIp: string | null;
  registeredBy: 'office_network' | 'approval' | null;
  decidedBy: string | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

interface Row {
  id: string;
  user_id: string;
  user_name: string;
  state: 'pending' | 'approved';
  label: string | null;
  last_ip: string | null;
  registered_by: 'office_network' | 'approval' | null;
  decider: string | null;
  last_used_at: Date | null;
  created_at: Date;
}

@Injectable()
export class OfficeComputersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ at sign-in (inside the sign-in transaction)

  async find(
    trx: Trx,
    userId: string,
    tokenHash: string,
  ): Promise<{ id: string; state: string; fresh: boolean } | undefined> {
    const { rows } = await sql<{ id: string; state: string; fresh: boolean }>`
      SELECT id, state, COALESCE(last_used_at, created_at) > now() - make_interval(days => ${STALE_DAYS}) AS fresh
      FROM office_computers WHERE user_id = ${userId} AND token_hash = ${tokenHash}`.execute(trx);
    return rows[0];
  }

  /** The computer signed in from an address on the office list: it is registered at once. A computer a person turned down stays turned down. */
  async registerFromOfficeNetwork(
    trx: Trx,
    a: { tenantId: string; userId: string; tokenHash: string; label: string; ip: string },
  ): Promise<void> {
    const { rows } = await sql<{ state: string }>`
      INSERT INTO office_computers (tenant_id, user_id, token_hash, state, registered_by, label, first_ip, last_ip, last_used_at)
      VALUES (${a.tenantId}, ${a.userId}, ${a.tokenHash}, 'approved', 'office_network', ${a.label}, ${a.ip}::inet, ${a.ip}::inet, now())
      ON CONFLICT (user_id, token_hash) DO UPDATE SET
        state = CASE WHEN office_computers.state = 'rejected' THEN 'rejected' ELSE 'approved' END,
        registered_by = CASE WHEN office_computers.state = 'rejected' THEN NULL WHEN office_computers.state = 'approved' THEN office_computers.registered_by ELSE 'office_network' END,
        last_ip = EXCLUDED.last_ip, last_used_at = now(), updated_at = now()
      RETURNING state`.execute(trx);
    if (rows[0]?.state === 'approved') await this.keepNewest(trx, a.userId, a.tokenHash);
  }

  /** Used a registered computer: remembers when and from where. */
  async touch(trx: Trx, id: string, ip: string): Promise<void> {
    await sql`UPDATE office_computers SET last_used_at = now(), last_ip = ${ip}::inet, updated_at = now() WHERE id = ${id}`.execute(
      trx,
    );
  }

  /**
   * An unregistered computer is at the office but not on an office address: ask for approval. Returns whether a new request was made
   * ('created'), one was already waiting ('waiting'), or a person has already turned this computer down ('rejected').
   */
  async requestApproval(
    trx: Trx,
    a: { tenantId: string; userId: string; tokenHash: string; label: string; ip: string },
  ): Promise<'created' | 'waiting' | 'rejected'> {
    const existing = await this.find(trx, a.userId, a.tokenHash);
    if (existing?.state === 'rejected') return 'rejected';
    if (existing?.state === 'pending') {
      await sql`UPDATE office_computers SET last_ip = ${a.ip}::inet, updated_at = now() WHERE id = ${existing.id}`.execute(
        trx,
      );
      return 'waiting';
    }
    if (existing) {
      await sql`UPDATE office_computers SET state = 'pending', registered_by = NULL, decided_by = NULL, decided_at = NULL, last_ip = ${a.ip}::inet, updated_at = now() WHERE id = ${existing.id}`.execute(
        trx,
      );
    } else {
      await sql`
        INSERT INTO office_computers (tenant_id, user_id, token_hash, state, label, first_ip, last_ip)
        VALUES (${a.tenantId}, ${a.userId}, ${a.tokenHash}, 'pending', ${a.label}, ${a.ip}::inet, ${a.ip}::inet)`.execute(
        trx,
      );
    }
    // A person cannot pile up requests: past the limit the oldest waiting ones are withdrawn.
    await sql`
      UPDATE office_computers SET state = 'removed', updated_at = now()
      WHERE id IN (SELECT id FROM office_computers WHERE user_id = ${a.userId} AND state = 'pending' ORDER BY created_at DESC OFFSET ${MAX_WAITING})`.execute(
      trx,
    );
    return 'created';
  }

  private async keepNewest(trx: Trx, userId: string, keepHash: string): Promise<void> {
    await sql`
      UPDATE office_computers SET state = 'removed', registered_by = NULL, updated_at = now()
      WHERE id IN (
        SELECT id FROM office_computers WHERE user_id = ${userId} AND state = 'approved' AND token_hash <> ${keepHash}
        ORDER BY COALESCE(last_used_at, created_at) DESC OFFSET ${MAX_COMPUTERS - 1})`.execute(trx);
  }

  // ------------------------------------------------------------------ for the people who manage them

  list(auth: AuthContext, state: 'pending' | 'approved'): Promise<ComputerView[]> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const scoped = scopeCondition(auth, 'c.user_id');
      const { rows } = await sql<Row>`
        SELECT c.id, c.user_id, u.name AS user_name, c.state, c.label, host(c.last_ip) AS last_ip, c.registered_by, d.name AS decider, c.last_used_at, c.created_at
        FROM office_computers c JOIN users u ON u.id = c.user_id LEFT JOIN users d ON d.id = c.decided_by
        WHERE c.state = ${state} ${andIf(scoped)}
        ORDER BY c.created_at DESC LIMIT 200`.execute(trx);
      return rows.map(toView);
    });
  }

  approve(auth: AuthContext, id: string): Promise<ComputerView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const row = await this.loadScoped(trx, auth, id);
      // The person a computer belongs to cannot be the one who vouches for it.
      if (row.user_id === auth.userId)
        throw new AppError('SELF_APPROVAL', 'Another person must approve your own computer', 403);
      if (row.state !== 'approved') {
        await sql`UPDATE office_computers SET state = 'approved', registered_by = 'approval', decided_by = ${auth.userId}, decided_at = now(), updated_at = now() WHERE id = ${id}`.execute(
          trx,
        );
        const { rows } = await sql<{
          token_hash: string;
        }>`SELECT token_hash FROM office_computers WHERE id = ${id}`.execute(trx);
        await this.keepNewest(trx, row.user_id, rows[0]!.token_hash);
        await this.audit.by(trx, auth, {
          action: 'office_computer.approve',
          entity: 'office_computer',
          entityId: id,
          after: { userId: row.user_id, label: row.label },
        });
      }
      return toView(await this.loadScoped(trx, auth, id));
    });
  }

  /** Turns a waiting request down, or takes a registered computer away. Either way that computer is not registered afterwards. */
  deny(auth: AuthContext, id: string, action: 'reject' | 'remove'): Promise<{ ok: true }> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const row = await this.loadScoped(trx, auth, id);
      const next = row.state === 'pending' && action === 'reject' ? 'rejected' : 'removed';
      await sql`UPDATE office_computers SET state = ${next}, registered_by = NULL, decided_by = ${auth.userId}, decided_at = now(), updated_at = now() WHERE id = ${id}`.execute(
        trx,
      );
      await this.audit.by(trx, auth, {
        action: next === 'rejected' ? 'office_computer.reject' : 'office_computer.remove',
        entity: 'office_computer',
        entityId: id,
        after: { userId: row.user_id, label: row.label },
      });
      return { ok: true as const };
    });
  }

  private async loadScoped(
    trx: Trx,
    auth: AuthContext,
    id: string,
  ): Promise<Row & { state: 'pending' | 'approved' }> {
    const scoped = scopeCondition(auth, 'c.user_id');
    const { rows } = await sql<Row>`
      SELECT c.id, c.user_id, u.name AS user_name, c.state, c.label, host(c.last_ip) AS last_ip, c.registered_by, d.name AS decider, c.last_used_at, c.created_at
      FROM office_computers c JOIN users u ON u.id = c.user_id LEFT JOIN users d ON d.id = c.decided_by
      WHERE c.id = ${id} AND c.state IN ('pending', 'approved') ${andIf(scoped)}`.execute(trx);
    if (!rows[0]) throw AppError.notFound('Computer');
    return rows[0];
  }
}

function toView(r: Row): ComputerView {
  return {
    id: r.id,
    user: { id: r.user_id, name: r.user_name },
    state: r.state,
    label: r.label,
    lastIp: r.last_ip,
    registeredBy: r.registered_by,
    decidedBy: r.decider,
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
  };
}
