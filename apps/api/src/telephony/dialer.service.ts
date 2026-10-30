import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { scopeCondition } from '../access/scope.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppError } from '../common/app-error.js';
import { DatabaseService, Trx } from '../database/database.service.js';
import { LeadAccess } from '../leads/lead-access.js';
import { CallsService, CallView } from './calls.service.js';

type Status = 'running' | 'paused' | 'stopped' | 'finished';

export interface DialerLead {
  leadId: string;
  leadNo: string;
  name: string;
  phone: string;
  state: 'pending' | 'called' | 'skipped';
}

export interface SessionView {
  id: string;
  status: Status;
  user: { id: string; name: string };
  startedAt: Date;
  endedAt: Date | null;
  counts: { total: number; pending: number; called: number; skipped: number };
  /** The lead the next call will go to. */
  current: DialerLead | null;
  leads?: DialerLead[];
}

interface SessionRow {
  id: string; status: Status; user_id: string; user_name: string; started_at: Date; ended_at: Date | null;
  total: string; pending: string; called: string; skipped: string;
}

const SELECT = sql`
  SELECT s.id, s.status, s.user_id, u.name AS user_name, s.started_at, s.ended_at,
         (SELECT count(*) FROM dialer_session_leads x WHERE x.session_id = s.id) AS total,
         (SELECT count(*) FROM dialer_session_leads x WHERE x.session_id = s.id AND x.state = 'pending') AS pending,
         (SELECT count(*) FROM dialer_session_leads x WHERE x.session_id = s.id AND x.state = 'called') AS called,
         (SELECT count(*) FROM dialer_session_leads x WHERE x.session_id = s.id AND x.state = 'skipped') AS skipped
  FROM dialer_sessions s JOIN users u ON u.id = s.user_id`;

const LEADS = (sessionId: string) => sql<{ lead_id: string; lead_no: string; name: string; primary_phone: string; state: DialerLead['state'] }>`
  SELECT x.lead_id, l.lead_no::text AS lead_no, l.name, l.primary_phone, x.state
  FROM dialer_session_leads x JOIN leads l ON l.id = x.lead_id
  WHERE x.session_id = ${sessionId}::uuid ORDER BY x.position`;

/**
 * The auto-dialer. A counsellor loads a list of leads; each call goes to the next lead in line, and
 * the session moves on after every outcome. A call that was answered must be written up before the
 * next one is placed. A session can be paused, resumed or stopped by its owner or by someone whose
 * data scope covers them.
 */
@Injectable()
export class DialerService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: LeadAccess,
    private readonly calls: CallsService,
  ) {}

  // ------------------------------------------------------------------ start

  start(auth: AuthContext, leadIds: string[]): Promise<SessionView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const { rows: active } = await sql<{ id: string }>`
        SELECT id FROM dialer_sessions WHERE user_id = ${auth.userId} AND status IN ('running', 'paused') LIMIT 1`.execute(trx);
      if (active[0]) throw new AppError('SESSION_ACTIVE', 'You already have a dialer session. Stop it before starting another.', 409, undefined, undefined, { sessionId: active[0].id });

      const ids = [...new Set(leadIds)];
      for (const id of ids) {
        const lead = await this.access.get(trx, auth, id);
        if (!lead.is_open) throw AppError.badRequest('LEAD_CLOSED', `${lead.name} is closed, so it cannot be called from the dialer`, [{ field: 'leadIds', message: `${lead.name} is closed` }]);
      }
      const { rows } = await sql<{ id: string }>`INSERT INTO dialer_sessions (tenant_id, user_id) VALUES (${auth.tenantId}, ${auth.userId}) RETURNING id`.execute(trx);
      const sessionId = rows[0]!.id;
      for (const [position, leadId] of ids.entries()) {
        await sql`INSERT INTO dialer_session_leads (tenant_id, session_id, lead_id, position) VALUES (${auth.tenantId}, ${sessionId}, ${leadId}, ${position})`.execute(trx);
      }
      return this.view(trx, auth, sessionId, true);
    });
  }

  // ------------------------------------------------------------------ reads

  current(auth: AuthContext): Promise<SessionView | null> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const { rows } = await sql<{ id: string }>`SELECT id FROM dialer_sessions WHERE user_id = ${auth.userId} AND status IN ('running', 'paused') LIMIT 1`.execute(trx);
      return rows[0] ? this.view(trx, auth, rows[0].id, true) : null;
    });
  }

  list(auth: AuthContext, query: { status?: Status; limit: number }): Promise<SessionView[]> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const scoped = scopeCondition(auth, 's.user_id');
      const { rows } = await sql<SessionRow>`
        ${SELECT} WHERE true ${query.status ? sql`AND s.status = ${query.status}` : sql``} ${scoped ? sql`AND ${scoped}` : sql``}
        ORDER BY s.started_at DESC, s.id DESC LIMIT ${query.limit}`.execute(trx);
      return Promise.all(rows.map(async (r) => toView(r, await this.leadsOf(trx, r.id), false)));
    });
  }

  get(auth: AuthContext, id: string): Promise<SessionView> {
    return this.db.withTenant(auth.tenantId, (trx) => this.view(trx, auth, id, true));
  }

  // ---------------------------------------------------------------- control

  /** Calls the next lead in line. */
  async dial(auth: AuthContext, id: string): Promise<{ call: CallView; lead: DialerLead; session: SessionView }> {
    const next = await this.db.withTenant(auth.tenantId, async (trx) => {
      const session = await this.lock(trx, auth, id);
      if (session.user_id !== auth.userId) throw AppError.forbidden();
      if (session.status === 'paused') throw new AppError('SESSION_PAUSED', 'The session is paused. Resume it to continue.', 409);
      if (session.status !== 'running') throw new AppError('SESSION_ENDED', 'This session has ended', 409);

      const { rows: waiting } = await sql<{ id: string }>`
        SELECT c.id FROM calls c WHERE c.dialer_session_id = ${id}::uuid AND c.outcome = 'connected' AND c.wrapped_up_at IS NULL LIMIT 1`.execute(trx);
      if (waiting[0]) throw new AppError('WRAP_UP_REQUIRED', 'Fill in the after-call form for your last call before the next one', 409, undefined, undefined, { callId: waiting[0].id });

      const lead = (await this.leadsOf(trx, id)).find((l) => l.state === 'pending');
      if (!lead) throw new AppError('SESSION_ENDED', 'There are no more leads in this session', 409);
      return lead;
    });

    const call = await this.calls.place(auth, next.leadId, {}, id);

    return this.db.withTenant(auth.tenantId, async (trx) => {
      await this.settle(trx, id, next.leadId, 'called');
      return { call, lead: { ...next, state: 'called' as const }, session: await this.view(trx, auth, id, true) };
    });
  }

  /** Leaves the current lead out and moves to the next. */
  skip(auth: AuthContext, id: string): Promise<SessionView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const session = await this.lock(trx, auth, id);
      if (session.user_id !== auth.userId) throw AppError.forbidden();
      if (session.status !== 'running' && session.status !== 'paused') throw new AppError('SESSION_ENDED', 'This session has ended', 409);
      const lead = (await this.leadsOf(trx, id)).find((l) => l.state === 'pending');
      if (!lead) throw new AppError('SESSION_ENDED', 'There are no more leads in this session', 409);
      await this.settle(trx, id, lead.leadId, 'skipped');
      return this.view(trx, auth, id, true);
    });
  }

  pause(auth: AuthContext, id: string) {
    return this.change(auth, id, ['running'], 'paused');
  }

  resume(auth: AuthContext, id: string) {
    return this.change(auth, id, ['paused'], 'running');
  }

  stop(auth: AuthContext, id: string) {
    return this.change(auth, id, ['running', 'paused'], 'stopped');
  }

  // ----------------------------------------------------------------- inner

  private change(auth: AuthContext, id: string, from: Status[], to: Status): Promise<SessionView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const session = await this.lock(trx, auth, id);
      if (!from.includes(session.status)) {
        throw new AppError('SESSION_STATE', `A session that is ${session.status} cannot be ${to === 'stopped' ? 'stopped' : to === 'paused' ? 'paused' : 'resumed'}`, 409);
      }
      await sql`UPDATE dialer_sessions SET status = ${to}, ended_at = ${to === 'stopped' ? sql`now()` : sql`ended_at`} WHERE id = ${id}::uuid`.execute(trx);
      return this.view(trx, auth, id, true);
    });
  }

  /** Marks a lead as dealt with, and finishes the session when none are left. */
  private async settle(trx: Trx, sessionId: string, leadId: string, state: 'called' | 'skipped'): Promise<void> {
    await sql`UPDATE dialer_session_leads SET state = ${state} WHERE session_id = ${sessionId}::uuid AND lead_id = ${leadId}::uuid AND state = 'pending'`.execute(trx);
    await sql`
      UPDATE dialer_sessions SET status = 'finished', ended_at = now()
      WHERE id = ${sessionId}::uuid AND status IN ('running', 'paused')
        AND NOT EXISTS (SELECT 1 FROM dialer_session_leads WHERE session_id = ${sessionId}::uuid AND state = 'pending')`.execute(trx);
  }

  /** The session, held still for the rest of the transaction, if the caller may act on it. */
  private async lock(trx: Trx, auth: AuthContext, id: string): Promise<{ status: Status; user_id: string }> {
    const scoped = scopeCondition(auth, 's.user_id');
    const { rows } = await sql<{ status: Status; user_id: string }>`
      SELECT s.status, s.user_id FROM dialer_sessions s WHERE s.id = ${id}::uuid ${scoped ? sql`AND ${scoped}` : sql``} FOR UPDATE OF s`.execute(trx);
    if (!rows[0]) throw AppError.notFound('Dialer session');
    return rows[0];
  }

  private async view(trx: Trx, auth: AuthContext, id: string, withLeads: boolean): Promise<SessionView> {
    const scoped = scopeCondition(auth, 's.user_id');
    const { rows } = await sql<SessionRow>`${SELECT} WHERE s.id = ${id}::uuid ${scoped ? sql`AND ${scoped}` : sql``}`.execute(trx);
    if (!rows[0]) throw AppError.notFound('Dialer session');
    return toView(rows[0], await this.leadsOf(trx, id), withLeads);
  }

  private async leadsOf(trx: Trx, id: string): Promise<DialerLead[]> {
    const { rows } = await LEADS(id).execute(trx);
    return rows.map((r) => ({ leadId: r.lead_id, leadNo: r.lead_no, name: r.name, phone: r.primary_phone, state: r.state }));
  }
}

function toView(r: SessionRow, leads: DialerLead[], withLeads: boolean): SessionView {
  return {
    id: r.id, status: r.status, user: { id: r.user_id, name: r.user_name }, startedAt: r.started_at, endedAt: r.ended_at,
    counts: { total: Number(r.total), pending: Number(r.pending), called: Number(r.called), skipped: Number(r.skipped) },
    current: r.status === 'running' || r.status === 'paused' ? (leads.find((l) => l.state === 'pending') ?? null) : null,
    ...(withLeads && { leads }),
  };
}
