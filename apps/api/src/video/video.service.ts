import { Inject, Injectable } from '@nestjs/common';
import { sql, SqlBool } from 'kysely';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth-context.js';
import { AuditService } from '../audit/audit.service.js';
import { AppError } from '../common/app-error.js';
import { decodeCursor, Page, toPage } from '../common/pagination.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DatabaseService, Trx } from '../database/database.service.js';
import { LeadAccess } from '../leads/lead-access.js';
import { LeadWriter } from '../leads/lead-writer.js';
import type { CallInput, HistoryQuery, InviteInput, LeadSessionInput, MeetingInput } from './video.dto.js';
import { inviteToken, LINK_HOURS, PRESENCE_STALE_SECONDS, type Outcome, type SessionKind, standardPerCallMinute } from './video-rules.js';
import { InviteRow, SessionRow, VideoStore } from './video-store.js';

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);
const cursorShape = z.object({ t: z.string(), i: z.string() });

export interface ParticipantView {
  id: string;
  kind: 'staff' | 'guest';
  userId: string | null;
  name: string;
  role: 'host' | 'participant';
  state: string;
  connected: boolean;
  firstJoinedAt: string | null;
  lastLeftAt: string | null;
  /** The address to send to an outside guest. Only for people who may manage the session. */
  link?: string;
  /** Whether the guest's link is already tied to a device. */
  deviceBound?: boolean;
}

export interface SessionView {
  id: string;
  type: 'call' | 'meeting';
  kind: SessionKind;
  title: string | null;
  description: string | null;
  leadId: string | null;
  leadName: string | null;
  leadNo: string | null;
  createdBy: string;
  createdAt: string;
  scheduledFor: string | null;
  expiresAt: string;
  maxMinutes: number;
  /** planned, ringing, waiting (ready, nobody in yet), live, or ended */
  phase: 'planned' | 'ringing' | 'waiting' | 'live' | 'ended';
  status: 'open' | 'ended';
  outcome: Outcome | null;
  startedAt: string | null;
  endedAt: string | null;
  durationSec: number | null;
  participants: ParticipantView[];
  /** The address for the lead (or the first guest), kept so the lead screen needs no second look. */
  guestUrl: string | null;
  canManage: boolean;
  /** Recording is not part of this version. Kept in the answer so screens and filters do not change later. */
  recordingStatus: 'not_enabled';
}

export interface HistoryItem {
  id: string;
  type: 'call' | 'meeting';
  kind: SessionKind;
  title: string | null;
  leadId: string | null;
  leadName: string | null;
  leadNo: string | null;
  createdBy: string;
  createdAt: string;
  scheduledFor: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationSec: number | null;
  phase: SessionView['phase'];
  outcome: Outcome | null;
  peopleInvited: number;
  peopleJoined: number;
  /** A few names, for the list. */
  people: string;
  recordingStatus: 'not_enabled';
}

interface HistoryRow {
  id: string;
  type: 'call' | 'meeting';
  kind: SessionKind;
  title: string | null;
  lead_id: string | null;
  lead_name: string | null;
  lead_no: string | null;
  creator_name: string;
  created_at: Date;
  scheduled_for: Date | null;
  started_at: Date | null;
  ended_at: Date | null;
  status: 'open' | 'ended';
  outcome: Outcome | null;
  ringing: boolean;
  invited: string;
  joined: string;
  people: string | null;
  sort_key: string;
}

@Injectable()
export class VideoService {
  constructor(
    private readonly db: DatabaseService,
    private readonly store: VideoStore,
    private readonly access: LeadAccess,
    private readonly writer: LeadWriter,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private requireConfigured(): void {
    if (!this.env.AGORA_APP_ID || !this.env.AGORA_APP_CERTIFICATE) {
      throw AppError.conflict('VIDEO_NOT_CONFIGURED', 'Calls and meetings are not set up yet. Add AGORA_APP_ID and AGORA_APP_CERTIFICATE to the environment.');
    }
  }

  /** Whether the feature is switched on, so the screen can hide its buttons instead of failing. */
  status(): { enabled: boolean } {
    return { enabled: Boolean(this.env.AGORA_APP_ID && this.env.AGORA_APP_CERTIFICATE) };
  }

  private maxPeople(kind: SessionKind): number {
    return kind === 'voice' ? this.env.COMMUNICATION_MAX_VOICE_PEOPLE : this.env.COMMUNICATION_MAX_VIDEO_PEOPLE;
  }

  private link(tenantId: string, i: Pick<InviteRow, 'id' | 'token_version'>): string {
    return `${this.env.WEB_URL.replace(/\/$/, '')}/meet/${inviteToken(this.env.JWT_ACCESS_SECRET, tenantId, i.id, i.token_version)}`;
  }

  // ------------------------------------------------------------------ views

  private canManage(auth: AuthContext, s: Pick<SessionRow, 'created_by'>): boolean {
    return s.created_by === auth.userId || auth.permissions.has('comm.manage');
  }

  private phase(s: Pick<SessionRow, 'status' | 'started_at' | 'scheduled_for'>, ringing: boolean, now: Date): SessionView['phase'] {
    if (s.status === 'ended') return 'ended';
    if (s.started_at) return 'live';
    if (ringing) return 'ringing';
    if (s.scheduled_for && new Date(s.scheduled_for).getTime() > now.getTime()) return 'planned';
    return 'waiting';
  }

  private view(auth: AuthContext, s: SessionRow, invites: InviteRow[]): SessionView {
    const now = new Date();
    const manage = this.canManage(auth, s);
    const participants = this.store.participants(invites, now).map((p, n): ParticipantView => {
      const row = invites[n]!;
      return row.kind === 'guest' && manage && row.state !== 'removed' ? { ...p, link: this.link(auth.tenantId, row), deviceBound: row.device_hash !== null } : p;
    });
    const firstGuest = participants.find((p) => p.link);
    const duration = s.started_at && s.ended_at ? Math.max(0, Math.round((new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) / 1000)) : null;
    return {
      id: s.id, type: s.type, kind: s.kind, title: s.title, description: s.description,
      leadId: s.lead_id, leadName: s.lead_name, leadNo: s.lead_no, createdBy: s.creator_name, createdAt: iso(s.created_at)!,
      scheduledFor: iso(s.scheduled_for), expiresAt: iso(s.expires_at)!, maxMinutes: s.max_minutes,
      phase: this.phase(s, invites.some((i) => i.state === 'ringing'), now), status: s.status, outcome: s.outcome,
      startedAt: iso(s.started_at), endedAt: iso(s.ended_at), durationSec: duration,
      participants, guestUrl: firstGuest?.link ?? null, canManage: manage, recordingStatus: 'not_enabled',
    };
  }

  private async fullView(trx: Trx, auth: AuthContext, id: string): Promise<SessionView> {
    return this.view(auth, await this.store.load(trx, id), await this.store.invites(trx, id));
  }

  // ---------------------------------------------------------------- creating

  private async insertSession(
    trx: Trx,
    auth: AuthContext,
    p: { type: 'call' | 'meeting'; kind: SessionKind; title?: string; description?: string; leadId?: string | null; scheduledFor: Date | null; maxMinutes: number },
  ): Promise<{ id: string; expires: Date }> {
    const now = new Date();
    if (p.scheduledFor && p.scheduledFor.getTime() < now.getTime() - 5 * 60_000) {
      throw AppError.badRequest('SCHEDULE_IN_PAST', 'Choose a time that has not passed', [{ field: 'scheduledFor', message: 'Choose a time that has not passed' }]);
    }
    // The link works until a day after the chosen start (or after now when there is none), and at least until the meeting is over.
    const expires = new Date((p.scheduledFor ?? now).getTime() + Math.max(LINK_HOURS * 3_600_000, p.maxMinutes * 60_000));
    const { rows } = await sql<{ id: string }>`
      INSERT INTO video_sessions (tenant_id, lead_id, created_by, type, kind, title, description, scheduled_for, expires_at, max_minutes)
      VALUES (${auth.tenantId}, ${p.leadId ?? null}, ${auth.userId}, ${p.type}, ${p.kind}, ${p.title ?? null}, ${p.description ?? null}, ${p.scheduledFor}, ${expires}, ${p.maxMinutes})
      RETURNING id`.execute(trx);
    const id = rows[0]!.id;
    const host = await this.store.addInvite(trx, { tenantId: auth.tenantId, sessionId: id, invitedBy: auth.userId, expiresAt: expires, role: 'host', state: 'accepted', userId: auth.userId });
    await this.store.event(trx, auth.tenantId, id, host, 'created', `${p.type} ${p.kind}`);
    return { id, expires };
  }

  /** The staff the caller wants to invite must exist, be active, and be allowed to take part in calls. */
  private async allowedStaff(trx: Trx, ids: readonly string[]): Promise<{ id: string; name: string }[]> {
    if (ids.length === 0) return [];
    const { rows } = await sql<{ id: string; name: string }>`
      SELECT u.id, u.name FROM users u
      WHERE u.id = ANY(${[...ids]}::uuid[]) AND u.status = 'active'
        AND EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = u.role_id AND p.code = 'video.host')`.execute(trx);
    if (rows.length !== new Set(ids).size) {
      throw AppError.conflict('INVITEE_UNAVAILABLE', 'One of the people you chose is not active or may not take part in calls and meetings.');
    }
    return rows;
  }

  /** The one-to-one session with the lead from the lead's page: the counsellor, and a link for the lead. */
  async startForLead(auth: AuthContext, leadId: string, input: LeadSessionInput): Promise<SessionView> {
    this.requireConfigured();
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const lead = await this.access.get(trx, auth, leadId);
      const { id, expires } = await this.insertSession(trx, auth, {
        type: 'call', kind: input.kind, leadId, scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : null, maxMinutes: input.maxMinutes,
      });
      const guest = await this.store.addInvite(trx, { tenantId: auth.tenantId, sessionId: id, invitedBy: auth.userId, expiresAt: expires, state: 'invited', guestName: lead.name.split(' ')[0] || 'Student' });
      await this.store.event(trx, auth.tenantId, id, guest, 'invited', 'lead');
      await this.writer.activity(trx, {
        tenantId: auth.tenantId, leadId, userId: auth.userId, type: 'note',
        remark: `${input.kind === 'voice' ? 'Voice' : 'Video'} call ${input.scheduledFor ? `planned for ${input.scheduledFor}` : 'created'} by ${auth.name}`,
      });
      await this.audit.write(trx, { tenantId: auth.tenantId, actorId: auth.userId, action: 'comm.create', entity: 'communication', entityId: id, after: { type: 'call', kind: input.kind, leadNo: lead.lead_no }, ip: auth.ip, requestId: auth.requestId });
      return this.fullView(trx, auth, id);
    });
  }

  /** A call to a colleague. It rings on their screen; a colleague already in a call is answered "busy" at once. */
  async callColleague(auth: AuthContext, input: CallInput): Promise<{ session: SessionView; busy: boolean }> {
    this.requireConfigured();
    if (input.toUserId === auth.userId) throw AppError.badRequest('CALL_SELF', 'Choose someone else to call', [{ field: 'toUserId', message: 'Choose someone else to call' }]);
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const callee = (await this.allowedStaff(trx, [input.toUserId]).catch(() => []))[0];
      if (!callee) throw AppError.conflict('CALLEE_UNAVAILABLE', 'That person cannot take calls right now.');
      if (input.leadId) await this.access.get(trx, auth, input.leadId);
      const busy = await this.isBusy(trx, input.toUserId);
      const { id, expires } = await this.insertSession(trx, auth, { type: 'call', kind: input.kind, leadId: input.leadId ?? null, scheduledFor: null, maxMinutes: input.maxMinutes });
      const invite = await this.store.addInvite(trx, { tenantId: auth.tenantId, sessionId: id, invitedBy: auth.userId, expiresAt: expires, state: busy ? 'busy' : 'ringing', userId: input.toUserId });
      const session = await this.store.load(trx, id);
      if (busy) {
        await this.store.event(trx, auth.tenantId, id, invite, 'busy', 'already in a call');
        await this.store.end(trx, session, 'busy', { detail: 'callee busy' });
      } else {
        await this.store.event(trx, auth.tenantId, id, invite, 'ringing');
        await this.store.notify(trx, auth.tenantId, [input.toUserId], 'comm_incoming', {
          sessionId: id, kind: input.kind, fromName: auth.name, leadId: input.leadId ?? undefined, leadName: session.lead_name ?? undefined,
        });
      }
      await this.audit.write(trx, { tenantId: auth.tenantId, actorId: auth.userId, action: 'comm.create', entity: 'communication', entityId: id, after: { type: 'call', kind: input.kind, to: callee.name, busy }, ip: auth.ip, requestId: auth.requestId });
      return { session: await this.fullView(trx, auth, id), busy };
    });
  }

  async createMeeting(auth: AuthContext, input: MeetingInput): Promise<SessionView> {
    this.requireConfigured();
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const staffIds = [...new Set(input.staffIds.filter((id) => id !== auth.userId))];
      if (1 + staffIds.length + input.guests.length > this.maxPeople(input.kind)) {
        throw AppError.conflict('TOO_MANY_PEOPLE', `A ${input.kind} meeting can have at most ${this.maxPeople(input.kind)} people.`);
      }
      const lead = input.leadId ? await this.access.get(trx, auth, input.leadId) : null;
      const staff = await this.allowedStaff(trx, staffIds);
      const scheduled = input.scheduledFor ? new Date(input.scheduledFor) : null;
      const { id, expires } = await this.insertSession(trx, auth, {
        type: 'meeting', kind: input.kind, title: input.title, description: input.description, leadId: input.leadId ?? null, scheduledFor: scheduled, maxMinutes: input.durationMinutes,
      });
      for (const person of staff) {
        const invite = await this.store.addInvite(trx, { tenantId: auth.tenantId, sessionId: id, invitedBy: auth.userId, expiresAt: expires, state: 'invited', userId: person.id });
        await this.store.event(trx, auth.tenantId, id, invite, 'invited');
      }
      for (const guest of input.guests) {
        const invite = await this.store.addInvite(trx, { tenantId: auth.tenantId, sessionId: id, invitedBy: auth.userId, expiresAt: expires, state: 'invited', guestName: guest.name });
        await this.store.event(trx, auth.tenantId, id, invite, 'invited', 'guest');
      }
      await this.store.notify(trx, auth.tenantId, staff.map((p) => p.id), 'comm_meeting_invite', {
        sessionId: id, title: input.title, kind: input.kind, fromName: auth.name, scheduledFor: input.scheduledFor,
      });
      if (lead) {
        await this.writer.activity(trx, { tenantId: auth.tenantId, leadId: lead.id, userId: auth.userId, type: 'note', remark: `Meeting "${input.title}" ${input.scheduledFor ? `planned for ${input.scheduledFor}` : 'created'} by ${auth.name}` });
      }
      await this.audit.write(trx, { tenantId: auth.tenantId, actorId: auth.userId, action: 'comm.create', entity: 'communication', entityId: id, after: { type: 'meeting', kind: input.kind, title: input.title, staff: staff.length, guests: input.guests.length }, ip: auth.ip, requestId: auth.requestId });
      return this.fullView(trx, auth, id);
    });
  }

  /** Whether someone is in a call right now, or another call is ringing for them. */
  async isBusy(trx: Trx, userId: string): Promise<boolean> {
    const { rows } = await sql`
      SELECT 1 FROM video_session_invites i JOIN video_sessions v ON v.id = i.session_id AND v.status = 'open'
      WHERE i.user_id = ${userId}::uuid
        AND ((i.joined_at IS NOT NULL AND i.last_seen_at > now() - make_interval(secs => ${PRESENCE_STALE_SECONDS}))
          OR (i.state = 'ringing' AND i.invited_at > now() - make_interval(secs => ${this.env.COMMUNICATION_RING_SECONDS})))
      LIMIT 1`.execute(trx);
    return rows.length > 0;
  }

  // ---------------------------------------------------------------- reading

  /** Sessions with one lead, newest first, for the lead's screen. */
  forLead(auth: AuthContext, leadId: string): Promise<SessionView[]> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      await this.access.get(trx, auth, leadId);
      const { rows } = await sql<{ id: string }>`
        SELECT v.id FROM video_sessions v LEFT JOIN leads l ON l.id = v.lead_id
        WHERE v.lead_id = ${leadId}::uuid AND ${this.store.visibleCondition(auth)} ORDER BY v.created_at DESC, v.id DESC LIMIT 20`.execute(trx);
      const out: SessionView[] = [];
      for (const r of rows) out.push(await this.fullView(trx, auth, r.id));
      return out;
    });
  }

  /** One session with its people and what happened, for those who may see it. */
  get(auth: AuthContext, id: string): Promise<SessionView & { events: { event: string; at: string; who: string | null; detail: string | null }[] }> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const session = await this.store.load(trx, id, { auth });
      const invites = await this.store.invites(trx, id);
      const { rows } = await sql<{ event: string; at: Date; who: string | null; detail: string | null }>`
        SELECT e.event, e.occurred_at AS at, COALESCE(u.name, i.guest_name) AS who, e.detail
        FROM video_session_events e LEFT JOIN video_session_invites i ON i.id = e.invite_id LEFT JOIN users u ON u.id = i.user_id
        WHERE e.session_id = ${id}::uuid ORDER BY e.occurred_at, e.id`.execute(trx);
      return { ...this.view(auth, session, invites), events: rows.map((r) => ({ event: r.event, at: iso(r.at)!, who: r.who, detail: r.detail })) };
    });
  }

  /** The history of calls and meetings the person may see, newest first, with filters. */
  history(auth: AuthContext, q: HistoryQuery): Promise<Page<HistoryItem>> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const after = decodeCursor(q.cursor, cursorShape);
      const c: ReturnType<typeof sql<SqlBool>>[] = [sql<SqlBool>`${this.store.visibleCondition(auth)}`];
      if (q.type) c.push(sql<SqlBool>`v.type = ${q.type}`);
      if (q.kind) c.push(sql<SqlBool>`v.kind = ${q.kind}`);
      if (q.outcome === 'open') c.push(sql<SqlBool>`v.status = 'open'`);
      else if (q.outcome) c.push(sql<SqlBool>`v.outcome = ${q.outcome}`);
      if (q.leadId) c.push(sql<SqlBool>`v.lead_id = ${q.leadId}::uuid`);
      if (q.userId) c.push(sql<SqlBool>`EXISTS (SELECT 1 FROM video_session_invites w WHERE w.session_id = v.id AND w.user_id = ${q.userId}::uuid)`);
      if (q.from) c.push(sql<SqlBool>`v.created_at >= (${q.from}::date::timestamp AT TIME ZONE t.timezone)`);
      if (q.to) c.push(sql<SqlBool>`v.created_at < ((${q.to}::date + 1)::timestamp AT TIME ZONE t.timezone)`);
      if (after) c.push(sql<SqlBool>`(v.created_at, v.id) < (${after.t}::timestamptz, ${after.i}::uuid)`);

      const { rows } = await sql<HistoryRow>`
        SELECT v.id, v.type, v.kind, v.title, v.lead_id, l.name AS lead_name, l.lead_no::text AS lead_no, u.name AS creator_name, v.created_at, v.scheduled_for,
               v.started_at, v.ended_at, v.status, v.outcome, v.created_at::text AS sort_key,
               EXISTS (SELECT 1 FROM video_session_invites r WHERE r.session_id = v.id AND r.state = 'ringing') AS ringing,
               (SELECT count(*) FROM video_session_invites x WHERE x.session_id = v.id AND (x.state <> 'removed' OR x.first_joined_at IS NOT NULL)) AS invited,
               (SELECT count(*) FROM video_session_invites x WHERE x.session_id = v.id AND x.first_joined_at IS NOT NULL) AS joined,
               (SELECT string_agg(name, ', ') FROM (SELECT COALESCE(pu.name, pi.guest_name) AS name FROM video_session_invites pi LEFT JOIN users pu ON pu.id = pi.user_id
                 WHERE pi.session_id = v.id AND pi.state <> 'removed' ORDER BY pi.role DESC, pi.invited_at LIMIT 4) names) AS people
        FROM video_sessions v JOIN users u ON u.id = v.created_by JOIN tenants t ON t.id = v.tenant_id LEFT JOIN leads l ON l.id = v.lead_id
        WHERE ${sql.join(c, sql` AND `)}
        ORDER BY v.created_at DESC, v.id DESC LIMIT ${q.limit + 1}`.execute(trx);

      const now = new Date();
      const page = toPage(rows, q.limit, (last) => ({ t: last.sort_key, i: last.id }));
      return {
        nextCursor: page.nextCursor,
        items: page.items.map((r): HistoryItem => ({
          id: r.id, type: r.type, kind: r.kind, title: r.title, leadId: r.lead_id, leadName: r.lead_name, leadNo: r.lead_no, createdBy: r.creator_name,
          createdAt: iso(r.created_at)!, scheduledFor: iso(r.scheduled_for), startedAt: iso(r.started_at), endedAt: iso(r.ended_at),
          durationSec: r.started_at && r.ended_at ? Math.max(0, Math.round((new Date(r.ended_at).getTime() - new Date(r.started_at).getTime()) / 1000)) : null,
          phase: this.phase(r, r.ringing, now),
          outcome: r.outcome, peopleInvited: Number(r.invited), peopleJoined: Number(r.joined), people: r.people ?? '', recordingStatus: 'not_enabled',
        })),
      };
    });
  }

  /** Colleagues who can be called, and whether each is busy right now. */
  colleagues(auth: AuthContext): Promise<{ id: string; name: string; role: string; busy: boolean }[]> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const { rows } = await sql<{ id: string; name: string; role: string; busy: boolean }>`
        SELECT u.id, u.name, r.name AS role,
               EXISTS (SELECT 1 FROM video_session_invites i JOIN video_sessions v ON v.id = i.session_id AND v.status = 'open'
                       WHERE i.user_id = u.id AND ((i.joined_at IS NOT NULL AND i.last_seen_at > now() - make_interval(secs => ${PRESENCE_STALE_SECONDS}))
                         OR (i.state = 'ringing' AND i.invited_at > now() - make_interval(secs => ${this.env.COMMUNICATION_RING_SECONDS})))) AS busy
        FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.status = 'active' AND u.id <> ${auth.userId}::uuid
          AND EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = u.role_id AND p.code = 'video.host')
        ORDER BY u.name`.execute(trx);
      return rows;
    });
  }

  /**
   * Agora minutes used this month, in Agora's own unit (Standard minutes) so they can be compared with the
   * package, and the same in plain words: how many minutes of a video call or of a voice call the rest of
   * the allowance would buy.
   */
  usage(auth: AuthContext): Promise<{ usedStandardMinutes: number; limitStandardMinutes: number | null; videoMinutesLeft: number | null; voiceMinutesLeft: number | null }> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const used = await this.store.standardMinutesUsed(trx);
      const limit = this.env.VIDEO_MONTHLY_MINUTE_LIMIT || null;
      const left = limit === null ? null : Math.max(0, limit - used);
      return {
        usedStandardMinutes: used,
        limitStandardMinutes: limit,
        videoMinutesLeft: left === null ? null : Math.floor(left / standardPerCallMinute('video')),
        voiceMinutesLeft: left === null ? null : Math.floor(left / standardPerCallMinute('voice')),
      };
    });
  }

  // -------------------------------------------------------------- managing

  /** Ends a session for everyone. A session nobody started is cancelled instead. */
  end(auth: AuthContext, id: string): Promise<SessionView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const session = await this.store.load(trx, id, { auth, lock: true });
      this.requireManage(auth, session);
      if (session.status === 'open') {
        const outcome: Outcome = session.started_at ? 'completed' : 'cancelled';
        await this.store.end(trx, session, outcome, { by: auth.userId, by_name: auth.name, detail: `ended by ${auth.name}` });
        const people = (await this.store.invites(trx, id)).filter((i) => i.user_id && i.user_id !== auth.userId && ['accepted', 'invited'].includes(i.state));
        await this.store.notify(trx, auth.tenantId, people.map((i) => i.user_id!), 'comm_ended', {
          sessionId: id, title: session.title ?? undefined, kind: session.kind, type: session.type, fromName: auth.name, cancelled: outcome === 'cancelled',
        });
        await this.audit.write(trx, { tenantId: auth.tenantId, actorId: auth.userId, action: 'comm.end', entity: 'communication', entityId: id, after: { outcome }, ip: auth.ip, requestId: auth.requestId });
      }
      return this.fullView(trx, auth, id);
    });
  }

  /** Adds a colleague or an outside guest to a meeting. */
  addInvite(auth: AuthContext, id: string, input: InviteInput): Promise<SessionView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const session = await this.store.load(trx, id, { auth, lock: true });
      this.requireManage(auth, session);
      if (session.status === 'ended') throw AppError.conflict('SESSION_ENDED', 'This session has ended.');
      if (session.type === 'call') throw AppError.conflict('CALL_IS_ONE_TO_ONE', 'A call is between two people. Create a meeting to add more.');
      if ((await this.store.headCount(trx, id)) + 1 > this.maxPeople(session.kind)) {
        throw AppError.conflict('TOO_MANY_PEOPLE', `A ${session.kind} meeting can have at most ${this.maxPeople(session.kind)} people.`);
      }
      const expires = session.expires_at;
      if (input.userId) {
        const userId = input.userId;
        const person = (await this.allowedStaff(trx, [userId]))[0]!;
        const existing = (await this.store.invites(trx, id)).find((i) => i.user_id === userId);
        if (existing && existing.state !== 'removed') throw AppError.conflict('ALREADY_INVITED', `${person.name} is already in this session.`);
        let inviteId: string;
        if (existing) {
          await sql`UPDATE video_session_invites SET state = 'invited', responded_at = NULL, token_version = token_version + 1 WHERE id = ${existing.id}::uuid`.execute(trx);
          inviteId = existing.id;
        } else {
          inviteId = await this.store.addInvite(trx, { tenantId: auth.tenantId, sessionId: id, invitedBy: auth.userId, expiresAt: expires, state: 'invited', userId });
        }
        await this.store.event(trx, auth.tenantId, id, inviteId, 'invited');
        await this.store.notify(trx, auth.tenantId, [userId], 'comm_meeting_invite', { sessionId: id, title: session.title ?? undefined, kind: session.kind, fromName: auth.name, scheduledFor: iso(session.scheduled_for) ?? undefined });
      } else {
        const inviteId = await this.store.addInvite(trx, { tenantId: auth.tenantId, sessionId: id, invitedBy: auth.userId, expiresAt: expires, state: 'invited', guestName: input.guestName! });
        await this.store.event(trx, auth.tenantId, id, inviteId, 'invited', 'guest');
      }
      await this.audit.write(trx, { tenantId: auth.tenantId, actorId: auth.userId, action: 'comm.invite', entity: 'communication', entityId: id, ip: auth.ip, requestId: auth.requestId });
      return this.fullView(trx, auth, id);
    });
  }

  /** Takes someone out of a session. Their link stops working, and a screen that is still open leaves within moments. */
  removeInvite(auth: AuthContext, id: string, inviteId: string): Promise<SessionView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const session = await this.store.load(trx, id, { auth, lock: true });
      this.requireManage(auth, session);
      const invite = await this.store.invite(trx, inviteId, { lock: true });
      if (invite.session_id !== id) throw AppError.notFound('Invitation');
      if (invite.role === 'host') throw AppError.conflict('CANNOT_REMOVE_HOST', 'The person who started the session cannot be removed. End the session instead.');
      if (invite.state !== 'removed') {
        await sql`UPDATE video_session_invites SET state = 'removed', token_version = token_version + 1, responded_at = now() WHERE id = ${inviteId}::uuid`.execute(trx);
        await this.store.event(trx, auth.tenantId, id, inviteId, 'removed', `removed by ${auth.name}`);
        await this.audit.write(trx, { tenantId: auth.tenantId, actorId: auth.userId, action: 'comm.remove', entity: 'communication', entityId: id, after: { invite: inviteId }, ip: auth.ip, requestId: auth.requestId });
      }
      return this.fullView(trx, auth, id);
    });
  }

  /** Lets a guest's link be opened from a new device (the guest changed phone). */
  resetDevice(auth: AuthContext, id: string, inviteId: string): Promise<SessionView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const session = await this.store.load(trx, id, { auth, lock: true });
      this.requireManage(auth, session);
      const invite = await this.store.invite(trx, inviteId, { lock: true });
      if (invite.session_id !== id || invite.kind !== 'guest') throw AppError.notFound('Invitation');
      await sql`UPDATE video_session_invites SET device_hash = NULL WHERE id = ${inviteId}::uuid`.execute(trx);
      await this.store.event(trx, auth.tenantId, id, inviteId, 'reset', `link released by ${auth.name}`);
      return this.fullView(trx, auth, id);
    });
  }

  private requireManage(auth: AuthContext, s: SessionRow): void {
    if (!this.canManage(auth, s)) throw AppError.forbidden('NOT_HOST', 'Only the person who started this session, or an Admin, can do this.');
  }
}
