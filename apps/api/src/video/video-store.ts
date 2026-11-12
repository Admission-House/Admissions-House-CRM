import { randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Expression, sql, SqlBool } from 'kysely';
import { leadVisibility } from '../access/lead-scope.js';
import { scopeCondition } from '../access/scope.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppError } from '../common/app-error.js';
import type { Trx } from '../database/database.service.js';
import { LeadWriter } from '../leads/lead-writer.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { isConnected, type InviteState, type Outcome, type SessionKind, type SessionType } from './video-rules.js';

export interface SessionRow {
  id: string;
  tenant_id: string;
  lead_id: string | null;
  lead_name: string | null;
  lead_no: string | null;
  created_by: string;
  creator_name: string;
  type: SessionType;
  kind: SessionKind;
  title: string | null;
  description: string | null;
  scheduled_for: Date | null;
  expires_at: Date;
  max_minutes: number;
  status: 'open' | 'ended';
  outcome: Outcome | null;
  started_at: Date | null;
  ended_at: Date | null;
  created_at: Date;
}

export interface InviteRow {
  id: string;
  session_id: string;
  kind: 'staff' | 'guest';
  user_id: string | null;
  user_name: string | null;
  guest_name: string | null;
  role: 'host' | 'participant';
  state: InviteState;
  agora_uid: number;
  token_version: number;
  device_hash: string | null;
  expires_at: Date;
  invited_at: Date;
  responded_at: Date | null;
  first_joined_at: Date | null;
  joined_at: Date | null;
  last_left_at: Date | null;
  last_seen_at: Date | null;
}

export type EventName = 'created' | 'invited' | 'ringing' | 'accepted' | 'declined' | 'missed' | 'busy' | 'joined' | 'left' | 'removed' | 'reset' | 'started' | 'ended' | 'reminder';

/** What the notification bell and the phone alert say about a call or meeting. */
export type CommunicationEvent = 'comm_incoming' | 'comm_missed' | 'comm_declined' | 'comm_meeting_invite' | 'comm_meeting_reminder' | 'comm_meeting_started' | 'comm_ended';

const SESSION_SELECT = sql`
  SELECT v.id, v.tenant_id, v.lead_id, l.name AS lead_name, l.lead_no::text AS lead_no, v.created_by, u.name AS creator_name, v.type, v.kind, v.title, v.description,
         v.scheduled_for, v.expires_at, v.max_minutes, v.status, v.outcome, v.started_at, v.ended_at, v.created_at
  FROM video_sessions v JOIN users u ON u.id = v.created_by LEFT JOIN leads l ON l.id = v.lead_id`;

/**
 * The shared database work of calls and meetings: loading a session and its people, who may see it, the
 * trail of events, notifying people and ending a session. The services on top decide what is allowed.
 */
@Injectable()
export class VideoStore {
  constructor(
    private readonly writer: LeadWriter,
    private readonly notifications: NotificationsService,
  ) {}

  /** Who may see a session: the people in it, whoever started it, whoever oversees them, and whoever may see its lead. */
  visibleCondition(auth: AuthContext): Expression<SqlBool> {
    const scope = scopeCondition(auth, 'v.created_by');
    if (!scope) return sql<SqlBool>`TRUE`;
    const parts = [
      sql<SqlBool>`v.created_by = ${auth.userId}::uuid`,
      sql<SqlBool>`EXISTS (SELECT 1 FROM video_session_invites me WHERE me.session_id = v.id AND me.user_id = ${auth.userId}::uuid)`,
      sql<SqlBool>`${scope}`,
    ];
    const lead = leadVisibility(auth, 'l.assigned_to');
    if (lead) parts.push(sql<SqlBool>`(l.id IS NOT NULL AND ${lead})`);
    return sql<SqlBool>`(${sql.join(parts, sql` OR `)})`;
  }

  /** A session, or a 404. With `auth`, only if that person may see it. With `lock`, held still until the transaction ends. */
  async load(trx: Trx, id: string, opts: { auth?: AuthContext; lock?: boolean } = {}): Promise<SessionRow> {
    const visible = opts.auth ? sql`AND ${this.visibleCondition(opts.auth)}` : sql``;
    const { rows } = await sql<SessionRow>`${SESSION_SELECT} WHERE v.id = ${id}::uuid ${visible} ${opts.lock ? sql`FOR UPDATE OF v` : sql``}`.execute(trx);
    if (!rows[0]) throw AppError.notFound('Session');
    return rows[0];
  }

  async invites(trx: Trx, sessionId: string): Promise<InviteRow[]> {
    const { rows } = await sql<InviteRow>`
      SELECT i.id, i.session_id, i.kind, i.user_id, u.name AS user_name, i.guest_name, i.role, i.state, i.agora_uid, i.token_version, i.device_hash,
             i.expires_at, i.invited_at, i.responded_at, i.first_joined_at, i.joined_at, i.last_left_at, i.last_seen_at
      FROM video_session_invites i LEFT JOIN users u ON u.id = i.user_id
      WHERE i.session_id = ${sessionId}::uuid ORDER BY i.invited_at, i.id`.execute(trx);
    return rows;
  }

  async invite(trx: Trx, id: string, opts: { lock?: boolean } = {}): Promise<InviteRow> {
    const { rows } = await sql<InviteRow>`
      SELECT i.id, i.session_id, i.kind, i.user_id, u.name AS user_name, i.guest_name, i.role, i.state, i.agora_uid, i.token_version, i.device_hash,
             i.expires_at, i.invited_at, i.responded_at, i.first_joined_at, i.joined_at, i.last_left_at, i.last_seen_at
      FROM video_session_invites i LEFT JOIN users u ON u.id = i.user_id
      WHERE i.id = ${id}::uuid ${opts.lock ? sql`FOR UPDATE OF i` : sql``}`.execute(trx);
    if (!rows[0]) throw AppError.notFound('Invitation');
    return rows[0];
  }

  async event(trx: Trx, tenantId: string, sessionId: string, inviteId: string | null, event: EventName, detail?: string): Promise<void> {
    await sql`INSERT INTO video_session_events (tenant_id, session_id, invite_id, event, detail) VALUES (${tenantId}, ${sessionId}, ${inviteId}, ${event}, ${detail ?? null})`.execute(trx);
  }

  /** A number for someone in the channel that nobody else in the session has. */
  async freeUid(trx: Trx, sessionId: string): Promise<number> {
    for (;;) {
      const uid = 1 + randomInt(2_147_483_646);
      const { rows } = await sql`SELECT 1 FROM video_session_invites WHERE session_id = ${sessionId}::uuid AND agora_uid = ${uid}`.execute(trx);
      if (rows.length === 0) return uid;
    }
  }

  /** Adds someone to a session. Returns the new invitation's id. */
  async addInvite(
    trx: Trx,
    p: { tenantId: string; sessionId: string; invitedBy: string; expiresAt: Date; role?: 'host' | 'participant'; state: InviteState } & ({ userId: string; guestName?: undefined } | { guestName: string; userId?: undefined }),
  ): Promise<string> {
    const uid = await this.freeUid(trx, p.sessionId);
    const { rows } = await sql<{ id: string }>`
      INSERT INTO video_session_invites (tenant_id, session_id, kind, user_id, guest_name, role, state, agora_uid, expires_at, invited_by, responded_at)
      VALUES (${p.tenantId}, ${p.sessionId}, ${p.userId ? 'staff' : 'guest'}, ${p.userId ?? null}, ${p.guestName ?? null}, ${p.role ?? 'participant'}, ${p.state},
              ${uid}, ${p.expiresAt}, ${p.invitedBy}, ${p.state === 'accepted' ? sql`now()` : null})
      RETURNING id`.execute(trx);
    return rows[0]!.id;
  }

  /** People who count towards the limit: everyone invited and not removed. */
  async headCount(trx: Trx, sessionId: string): Promise<number> {
    const { rows } = await sql<{ n: string }>`SELECT count(*) AS n FROM video_session_invites WHERE session_id = ${sessionId}::uuid AND state <> 'removed'`.execute(trx);
    return Number(rows[0]?.n ?? 0);
  }

  notify(trx: Trx, tenantId: string, userIds: readonly string[], event: CommunicationEvent, payload: Record<string, unknown>): Promise<number> {
    return this.notifications.notify(trx, { tenantId, userIds, type: 'communication', payload: { event, ...payload } });
  }

  /**
   * Ends a session for good. Anyone still connected is marked as having left. A session that never started
   * can only be cancelled, missed, declined or busy, never "completed".
   */
  async end(trx: Trx, session: SessionRow, outcome: Outcome, opts: { by?: string; by_name?: string; detail?: string } = {}): Promise<void> {
    const done = await sql`
      UPDATE video_sessions SET status = 'ended', outcome = ${outcome}, ended_at = GREATEST(now(), COALESCE(started_at, now())), ended_by = ${opts.by ?? null}
      WHERE id = ${session.id}::uuid AND status = 'open'`.execute(trx);
    if (Number(done.numAffectedRows ?? 0) === 0) return;
    await sql`
      UPDATE video_session_invites SET joined_at = NULL, last_left_at = COALESCE(last_left_at, now())
      WHERE session_id = ${session.id}::uuid AND joined_at IS NOT NULL`.execute(trx);
    await this.event(trx, session.tenant_id, session.id, null, 'ended', opts.detail ?? outcome);
    if (session.lead_id && session.started_at) {
      const minutes = Math.max(1, Math.round((Date.now() - new Date(session.started_at).getTime()) / 60_000));
      await this.writer.activity(trx, {
        tenantId: session.tenant_id, leadId: session.lead_id, userId: opts.by ?? session.created_by, type: 'note',
        remark: `${session.kind === 'voice' ? 'Voice' : 'Video'} ${session.type === 'meeting' ? 'meeting' : 'call'} ended after about ${minutes} min${opts.by_name ? ` (by ${opts.by_name})` : ''}`,
      });
    }
  }

  /**
   * Standard minutes used this month, an upper bound: every session counts from its start to its end (or to
   * its planned end if nobody ended it), for every person who connected (never fewer than two), at the rate
   * of its kind.
   */
  async standardMinutesUsed(trx: Trx): Promise<number> {
    const { rows } = await sql<{ minutes: number }>`
      SELECT COALESCE(SUM(
               CEIL(EXTRACT(EPOCH FROM (
                 LEAST(COALESCE(v.ended_at, v.started_at + v.max_minutes * interval '1 minute'), v.started_at + v.max_minutes * interval '1 minute', now()) - v.started_at)) / 60)
               * GREATEST((SELECT count(*) FROM video_session_invites i WHERE i.session_id = v.id AND i.first_joined_at IS NOT NULL), 2)
               * CASE v.kind WHEN 'voice' THEN 1 ELSE 4 END), 0)::int AS minutes
      FROM video_sessions v JOIN tenants t ON t.id = v.tenant_id
      WHERE v.started_at >= (date_trunc('month', now() AT TIME ZONE t.timezone) AT TIME ZONE t.timezone)`.execute(trx);
    return rows[0]?.minutes ?? 0;
  }

  /** The people of a session as the screens show them. */
  participants(invites: readonly InviteRow[], now: Date) {
    return invites.map((i) => ({
      id: i.id,
      kind: i.kind,
      userId: i.user_id,
      name: i.kind === 'staff' ? (i.user_name ?? 'Staff') : (i.guest_name ?? 'Guest'),
      role: i.role,
      state: i.state,
      connected: isConnected(i, now),
      firstJoinedAt: i.first_joined_at ? new Date(i.first_joined_at).toISOString() : null,
      lastLeftAt: i.last_left_at ? new Date(i.last_left_at).toISOString() : null,
    }));
  }
}
