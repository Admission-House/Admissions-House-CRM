import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { leadVisibility } from '../access/lead-scope.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppError } from '../common/app-error.js';
import { SlidingWindowLimiter } from '../common/rate-limiter.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DatabaseService, Trx } from '../database/database.service.js';
import {
  buildRtcToken, channelOf, inviteTokenGenuine, parseInviteToken, RTC_TOKEN_SECONDS, secondsLeft, sessionProblem, type SessionKind, type SessionType, standardPerCallMinute,
} from './video-rules.js';
import { statusBeforeAnyRecording } from '../recording/recording-rules.js';
import { RecordingService, type SessionRecordingStatus } from '../recording/recording.service.js';
import { InviteRow, SessionRow, VideoStore } from './video-store.js';

/** What a student may know before joining: who invited them and to what. Nothing that lets them in. */
export interface GuestInfo {
  companyName: string;
  hostName: string;
  guestName: string;
  kind: 'voice' | 'video';
  title: string | null;
  /** The session is over, or the link has run out: the page says so instead of offering to join. */
  ended: boolean;
}

export interface JoinAnswer {
  appId: string;
  channel: string;
  token: string;
  uid: number;
  /** Seconds of call time left. The token is renewed before it ends, for as long as the person may stay. */
  secondsLeft: number;
  /** How long this token lasts; ask again a little before. */
  tokenSeconds: number;
  kind: SessionKind;
  type: SessionType;
  title: string | null;
  /** True when the session is recorded and this person has agreed to the notice. */
  recordingEnabled: boolean;
}

export interface Snapshot {
  status: 'open' | 'ended';
  outcome: string | null;
  secondsLeft: number;
  /** True once the person has been taken out; their screen must leave. */
  removed: boolean;
  participants: { name: string; kind: 'staff' | 'guest'; state: string; connected: boolean }[];
  /** The recorder is a member of the channel; screens must not show it as a person. */
  recording: { status: SessionRecordingStatus; botUid: number | null };
}

export type Presence = 'joined' | 'ping' | 'left';

const sha = (v: string): string => createHash('sha256').update(v).digest('hex');

/** What a person needs to be in a call: joining, staying, answering a ring. For staff and for outside guests. */
@Injectable()
export class VideoAccessService {
  /** Joins from one address, so the public join address cannot be used to hammer the database. */
  private readonly joinsPerAddress = new SlidingWindowLimiter(60, 60_000);
  private readonly badLinksPerAddress = new SlidingWindowLimiter(10, 60_000);

  constructor(
    private readonly db: DatabaseService,
    private readonly store: VideoStore,
    private readonly recording: RecordingService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private config(): { appId: string; certificate: string } {
    const appId = this.env.AGORA_APP_ID;
    const certificate = this.env.AGORA_APP_CERTIFICATE;
    if (!appId || !certificate) throw AppError.conflict('VIDEO_NOT_CONFIGURED', 'Calls and meetings are not set up yet.');
    return { appId, certificate };
  }

  private maxPeople(kind: SessionKind): number {
    return kind === 'voice' ? this.env.COMMUNICATION_MAX_VOICE_PEOPLE : this.env.COMMUNICATION_MAX_VIDEO_PEOPLE;
  }

  /**
   * Refuses a session that cannot be joined, and starts its clock when the first person arrives. Starting is
   * also where the monthly limit is checked, so a session already running is never cut off by it.
   */
  private assertJoinable(session: SessionRow): void {
    const problem = sessionProblem(session, new Date());
    if (problem === 'ended') throw AppError.conflict('SESSION_ENDED', 'This session has ended.');
    if (problem === 'time_up') throw AppError.conflict('SESSION_ENDED', 'The time for this session is over.');
    if (problem === 'link_expired') throw AppError.conflict('LINK_EXPIRED', 'This link has expired. Ask for a new one.');
    if (problem === 'too_early') {
      throw AppError.conflict('MEETING_NOT_STARTED', 'This meeting has not started yet. It opens a few minutes before the planned time.', { scheduledFor: session.scheduled_for?.toISOString() });
    }
  }

  private async startIfFirst(trx: Trx, session: SessionRow, joiningUserId: string | null): Promise<SessionRow> {
    const problem = sessionProblem(session, new Date());
    if (problem === 'ended') throw AppError.conflict('SESSION_ENDED', 'This session has ended.');
    if (problem === 'time_up') throw AppError.conflict('SESSION_ENDED', 'The time for this session is over.');
    if (problem === 'link_expired') throw AppError.conflict('LINK_EXPIRED', 'This link has expired. Ask for a new one.');
    if (problem === 'too_early') {
      throw AppError.conflict('MEETING_NOT_STARTED', 'This meeting has not started yet. It opens a few minutes before the planned time.', { scheduledFor: session.scheduled_for?.toISOString() });
    }
    if (session.started_at) return session;

    const limit = this.env.VIDEO_MONTHLY_MINUTE_LIMIT;
    if (limit > 0 && (await this.store.standardMinutesUsed(trx)) + session.max_minutes * standardPerCallMinute(session.kind) > limit) {
      throw AppError.conflict('VIDEO_LIMIT_REACHED', 'The calling minutes for this month are used up. Please try again next month, or use a phone call.');
    }
    const started = await sql`UPDATE video_sessions SET started_at = now() WHERE id = ${session.id}::uuid AND started_at IS NULL`.execute(trx);
    if (Number(started.numAffectedRows ?? 0) > 0) {
      await this.store.event(trx, session.tenant_id, session.id, null, 'started');
      if (session.type === 'meeting') {
        const waiting = (await this.store.invites(trx, session.id)).filter((i) => i.user_id && i.user_id !== joiningUserId && ['invited', 'accepted'].includes(i.state));
        await this.store.notify(trx, session.tenant_id, waiting.map((i) => i.user_id!), 'comm_meeting_started', { sessionId: session.id, title: session.title ?? undefined, kind: session.kind, fromName: session.creator_name });
      }
    }
    return this.store.load(trx, session.id);
  }

  private token(session: SessionRow, invite: InviteRow): JoinAnswer {
    const cfg = this.config();
    const left = secondsLeft(session, new Date());
    const life = Math.min(RTC_TOKEN_SECONDS, left);
    const channel = channelOf(session.id);
    return {
      appId: cfg.appId, channel, uid: invite.agora_uid, secondsLeft: left, tokenSeconds: life, kind: session.kind, type: session.type, title: session.title, recordingEnabled: session.recording_enabled,
      token: buildRtcToken(cfg.appId, cfg.certificate, channel, invite.agora_uid, life),
    };
  }

  private async snapshot(trx: Trx, session: SessionRow, invites: InviteRow[], me: InviteRow): Promise<Snapshot> {
    const { rows } = await sql<{ status: SessionRecordingStatus; bot_uid: number }>`
      SELECT status, bot_uid FROM session_recordings WHERE session_id = ${session.id}::uuid ORDER BY created_at DESC LIMIT 1`.execute(trx);
    const latest = rows[0];
    const live = latest && ['pending', 'starting', 'recording', 'stopping'].includes(latest.status);
    return {
      recording: { status: latest?.status ?? statusBeforeAnyRecording(session), botUid: live ? latest.bot_uid : null },
      status: session.status,
      outcome: session.outcome,
      secondsLeft: session.status === 'ended' ? 0 : secondsLeft(session, new Date()),
      removed: me.state === 'removed',
      participants: this.store.participants(invites, new Date()).filter((p) => p.state !== 'removed').map((p) => ({ name: p.name, kind: p.kind, state: p.state, connected: p.connected })),
    };
  }

  /** Records that a screen is connected, still here, or gone. Does nothing for a session that is over. */
  private async applyPresence(trx: Trx, session: SessionRow, invite: InviteRow, event: Presence): Promise<void> {
    if (session.status === 'ended' || invite.state === 'removed') return;
    const connected = invite.joined_at !== null;
    if (event === 'left') {
      if (connected) {
        await sql`UPDATE video_session_invites SET joined_at = NULL, last_left_at = now(), last_seen_at = now() WHERE id = ${invite.id}::uuid`.execute(trx);
        await this.store.event(trx, session.tenant_id, session.id, invite.id, 'left');
      }
      return;
    }
    // 'joined', or a ping from a screen the server thought had gone: it is (back) in the call.
    await sql`
      UPDATE video_session_invites SET joined_at = COALESCE(joined_at, now()), first_joined_at = COALESCE(first_joined_at, now()), last_seen_at = now()
      WHERE id = ${invite.id}::uuid`.execute(trx);
    if (!connected) await this.store.event(trx, session.tenant_id, session.id, invite.id, 'joined', event === 'ping' ? 'reconnected' : undefined);
  }

  // ------------------------------------------------------------------ staff

  /** A staff member's way in, and also how a token is renewed. Someone who may see the session but was not invited joins as an observer. */
  async join(auth: AuthContext, sessionId: string, consent?: boolean): Promise<JoinAnswer> {
    this.config();
    const answer = await this.db.withTenant(auth.tenantId, async (trx) => {
      const session = await this.store.load(trx, sessionId, { auth, lock: true });
      let invite = (await this.store.invites(trx, sessionId)).find((i) => i.user_id === auth.userId);
      if (invite?.state === 'removed') throw AppError.forbidden('REMOVED', 'You were taken out of this session.');
      this.assertJoinable(session);
      // A recorded session lets in only people who agreed to the notice. Someone who has not yet agreed gets
      // the notice and nothing else happens: no clock is started, nobody is told, nothing is recorded.
      if (session.recording_enabled && !invite?.consented_at && consent !== true) await this.recording.requireConsent(trx, session, { id: invite?.id ?? '', consented_at: null }, consent);
      const started = await this.startIfFirst(trx, session, auth.userId);
      if (!invite) {
        if ((await this.store.headCount(trx, sessionId)) + 1 > this.maxPeople(session.kind)) throw AppError.conflict('TOO_MANY_PEOPLE', 'This session is full.');
        const id = await this.store.addInvite(trx, { tenantId: auth.tenantId, sessionId, invitedBy: auth.userId, expiresAt: session.expires_at, state: 'accepted', userId: auth.userId });
        await this.store.event(trx, auth.tenantId, sessionId, id, 'accepted', 'joined as an observer');
        invite = await this.store.invite(trx, id);
      } else if (invite.state !== 'accepted') {
        await sql`UPDATE video_session_invites SET state = 'accepted', responded_at = COALESCE(responded_at, now()) WHERE id = ${invite.id}::uuid`.execute(trx);
        await this.store.event(trx, auth.tenantId, sessionId, invite.id, 'accepted');
        invite = await this.store.invite(trx, invite.id);
      }
      await sql`UPDATE video_session_invites SET last_seen_at = now() WHERE id = ${invite.id}::uuid`.execute(trx);
      if (started.recording_enabled) {
        await this.recording.requireConsent(trx, started, invite, consent);
        await this.recording.ensureRecording(trx, started);
      }
      return this.token(started, invite);
    });
    this.recording.kick(auth.tenantId); // the recording starts at once, without making this person wait for it
    return answer;
  }

  /** A staff screen reports in; the answer tells it whether the session is still on and who is in it. */
  presence(auth: AuthContext, sessionId: string, event: Presence): Promise<Snapshot> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const session = await this.store.load(trx, sessionId, { auth, lock: true });
      const invites = await this.store.invites(trx, sessionId);
      const me = invites.find((i) => i.user_id === auth.userId);
      if (!me) throw AppError.notFound('Invitation');
      await this.applyPresence(trx, session, me, event);
      return this.snapshot(trx, await this.store.load(trx, sessionId), await this.store.invites(trx, sessionId), await this.store.invite(trx, me.id));
    });
  }

  /** Answers a ring or an invitation. Turning down a call that nobody has joined ends it as declined. */
  respond(auth: AuthContext, sessionId: string, action: 'accept' | 'decline'): Promise<{ sessionId: string; accepted: boolean }> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const session = await this.store.load(trx, sessionId, { auth, lock: true });
      const me = (await this.store.invites(trx, sessionId)).find((i) => i.user_id === auth.userId);
      if (!me || me.role === 'host') throw AppError.notFound('Invitation');
      if (session.status === 'ended') throw AppError.conflict('SESSION_ENDED', session.outcome === 'missed' ? 'You missed this call.' : 'This session has ended.');
      if (me.state === 'removed') throw AppError.forbidden('REMOVED', 'You were taken out of this session.');
      if (action === 'accept') {
        if (me.state !== 'accepted') {
          await sql`UPDATE video_session_invites SET state = 'accepted', responded_at = now() WHERE id = ${me.id}::uuid`.execute(trx);
          await this.store.event(trx, auth.tenantId, sessionId, me.id, 'accepted');
        }
        return { sessionId, accepted: true };
      }
      await sql`UPDATE video_session_invites SET state = 'declined', responded_at = now() WHERE id = ${me.id}::uuid`.execute(trx);
      await this.store.event(trx, auth.tenantId, sessionId, me.id, 'declined');
      if (session.type === 'call' && !session.started_at) {
        await this.store.end(trx, session, 'declined', { detail: `declined by ${auth.name}` });
        await this.store.notify(trx, auth.tenantId, [session.created_by], 'comm_declined', { sessionId, kind: session.kind, fromName: auth.name });
      }
      return { sessionId, accepted: false };
    });
  }

  /** What is ringing for this person right now. */
  incoming(auth: AuthContext): Promise<{ sessionId: string; kind: SessionKind; type: SessionType; title: string | null; fromName: string; leadId: string | null; leadName: string | null; secondsLeft: number }[]> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const lead = leadVisibility(auth, 'l.assigned_to');
      const { rows } = await sql<{ session_id: string; kind: SessionKind; type: SessionType; title: string | null; from_name: string; lead_id: string | null; lead_name: string | null; left: number }>`
        SELECT v.id AS session_id, v.kind, v.type, v.title, u.name AS from_name,
               CASE WHEN l.id IS NOT NULL ${lead ? sql`AND ${lead}` : sql``} THEN l.id END AS lead_id,
               CASE WHEN l.id IS NOT NULL ${lead ? sql`AND ${lead}` : sql``} THEN l.name END AS lead_name,
               GREATEST(0, ${this.env.COMMUNICATION_RING_SECONDS} - EXTRACT(EPOCH FROM now() - i.invited_at))::int AS left
        FROM video_session_invites i JOIN video_sessions v ON v.id = i.session_id AND v.status = 'open'
        JOIN users u ON u.id = v.created_by LEFT JOIN leads l ON l.id = v.lead_id
        WHERE i.user_id = ${auth.userId}::uuid AND i.state = 'ringing' AND i.invited_at > now() - make_interval(secs => ${this.env.COMMUNICATION_RING_SECONDS})
        ORDER BY i.invited_at DESC`.execute(trx);
      return rows.map((r) => ({ sessionId: r.session_id, kind: r.kind, type: r.type, title: r.title, fromName: r.from_name, leadId: r.lead_id, leadName: r.lead_name, secondsLeft: r.left }));
    });
  }

  // ------------------------------------------------------------------ guest

  /**
   * Checks a guest's link and device. A link that does not match anything answers the same "not found" as a
   * made-up one, and repeated bad links from one address are slowed down.
   */
  /** Every wrong, changed or cancelled link gets the same answer; many of them in a row get slowed down. */
  private badGuestLink(ip: string): never {
    const slow = this.badLinksPerAddress.hit(ip);
    if (slow) throw new AppError('RATE_LIMITED', 'Too many tries. Please wait a moment.', 429, undefined, { 'retry-after': String(slow) });
    throw AppError.notFound('Invitation');
  }

  /** The invitation a guest link belongs to, once the link is shown to be genuine and the guest has not been taken out. */
  private async genuineGuestInvite(trx: Trx, link: string, ip: string, lock: boolean): Promise<{ invite: InviteRow; tenantId: string }> {
    const parsed = parseInviteToken(link);
    if (!parsed) return this.badGuestLink(ip);
    const invite = await this.store.invite(trx, parsed.inviteId, lock ? { lock: true } : undefined).catch(() => null);
    if (!invite || invite.kind !== 'guest' || !inviteTokenGenuine(this.env.JWT_ACCESS_SECRET, parsed, invite.token_version)) return this.badGuestLink(ip);
    if (invite.state === 'removed') throw AppError.forbidden('REMOVED', 'You were taken out of this session.');
    return { invite, tenantId: parsed.tenantId };
  }

  private async guestInvite(trx: Trx, link: string, deviceId: string, ip: string, bind: boolean): Promise<{ session: SessionRow; invite: InviteRow; tenantId: string }> {
    const { invite, tenantId } = await this.genuineGuestInvite(trx, link, ip, true);
    if (new Date(invite.expires_at).getTime() <= Date.now()) throw AppError.conflict('LINK_EXPIRED', 'This link has expired. Ask for a new one.');
    const hash = sha(deviceId);
    if (invite.device_hash && invite.device_hash !== hash) {
      throw AppError.conflict('INVITE_USED_ELSEWHERE', 'This link is already in use on another device. Ask the person who sent it to release it.');
    }
    if (!invite.device_hash && bind) await sql`UPDATE video_session_invites SET device_hash = ${hash} WHERE id = ${invite.id}::uuid`.execute(trx);
    const session = await this.store.load(trx, invite.session_id, { lock: true });
    return { session, invite, tenantId };
  }

  private guestRate(ip: string): void {
    const wait = this.joinsPerAddress.hit(ip);
    if (wait) throw new AppError('RATE_LIMITED', 'Too many tries. Please wait a moment.', 429, undefined, { 'retry-after': String(wait) });
  }

  /**
   * The student's greeting page: who is calling and what for. Changes nothing (no device is tied to the link, nothing
   * starts), so opening the link, or a chat app previewing it, costs nothing. A wrong or cancelled link looks like any other.
   */
  async guestInfo(link: string, ip: string): Promise<GuestInfo> {
    this.guestRate(ip);
    const parsed = parseInviteToken(link);
    if (!parsed) return this.badGuestLink(ip);
    return this.db.withTenant(parsed.tenantId, async (trx) => {
      const { invite } = await this.genuineGuestInvite(trx, link, ip, false);
      const session = await this.store.load(trx, invite.session_id);
      const { rows } = await sql<{ name: string }>`SELECT name FROM tenants WHERE id = ${parsed.tenantId}::uuid`.execute(trx);
      return {
        companyName: rows[0]?.name ?? '',
        hostName: session.creator_name,
        guestName: invite.guest_name ?? '',
        kind: session.kind,
        title: session.title,
        ended: session.status === 'ended' || new Date(invite.expires_at).getTime() <= Date.now(),
      };
    });
  }

  /** The outside guest's way in (and the renewal of their token). Only the link and the device they first used work. */
  async guestJoin(link: string, deviceId: string, name: string | undefined, consent: boolean | undefined, ip: string): Promise<JoinAnswer & { guestName: string; hostName: string; companyName: string }> {
    this.guestRate(ip);
    this.config();
    const parsed = parseInviteToken(link);
    if (!parsed) {
      this.badLinksPerAddress.hit(ip);
      throw AppError.notFound('Invitation');
    }
    const answer = await this.db.withTenant(parsed.tenantId, async (trx) => {
      const { session, invite } = await this.guestInvite(trx, link, deviceId, ip, true);
      this.assertJoinable(session);
      // The notice comes before anything else: no agreement, no entry, and nothing is started or recorded.
      await this.recording.requireConsent(trx, session, invite, consent);
      const started = await this.startIfFirst(trx, session, null);
      await sql`
        UPDATE video_session_invites SET state = 'accepted', responded_at = COALESCE(responded_at, now()), last_seen_at = now(),
               guest_name = COALESCE(${name ?? null}, guest_name)
        WHERE id = ${invite.id}::uuid`.execute(trx);
      if (invite.state !== 'accepted') await this.store.event(trx, parsed.tenantId, session.id, invite.id, 'accepted');
      const { rows } = await sql<{ company: string; guest: string }>`
        SELECT t.name AS company, i.guest_name AS guest FROM tenants t, video_session_invites i WHERE t.id = ${parsed.tenantId}::uuid AND i.id = ${invite.id}::uuid`.execute(trx);
      if (started.recording_enabled) await this.recording.ensureRecording(trx, started);
      return { ...this.token(started, invite), guestName: rows[0]?.guest ?? invite.guest_name ?? '', hostName: session.creator_name, companyName: rows[0]?.company ?? '' };
    });
    this.recording.kick(parsed.tenantId);
    return answer;
  }

  async guestPresence(link: string, deviceId: string, event: Presence, ip: string): Promise<Snapshot> {
    this.guestRate(ip);
    const parsed = parseInviteToken(link);
    if (!parsed) {
      this.badLinksPerAddress.hit(ip);
      throw AppError.notFound('Invitation');
    }
    return this.db.withTenant(parsed.tenantId, async (trx) => {
      const { session, invite } = await this.guestInvite(trx, link, deviceId, ip, false);
      if (!invite.device_hash) throw AppError.notFound('Invitation');
      await this.applyPresence(trx, session, invite, event);
      return this.snapshot(trx, await this.store.load(trx, session.id), await this.store.invites(trx, session.id), await this.store.invite(trx, invite.id));
    });
  }
}
