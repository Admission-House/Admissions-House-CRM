import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { AuthContext } from '../auth/auth-context.js';
import { AuditService } from '../audit/audit.service.js';
import { AppError } from '../common/app-error.js';
import { SlidingWindowLimiter } from '../common/rate-limiter.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DatabaseService, Trx } from '../database/database.service.js';
import { LeadAccess } from '../leads/lead-access.js';
import { LeadWriter } from '../leads/lead-writer.js';
import {
  buildRtcToken, channelOf, guestToken, LINK_HOURS, randomUid, readGuestToken, secondsLeft, sessionProblem, STANDARD_PER_CALL_MINUTE,
} from './video-rules.js';

interface SessionRow {
  id: string;
  lead_id: string;
  created_by: string;
  scheduled_for: Date | null;
  expires_at: Date;
  max_minutes: number;
  status: string;
  started_at: Date | null;
  ended_at: Date | null;
  created_at: Date;
  creator_name: string;
}

export interface VideoSessionView {
  id: string;
  leadId: string;
  status: 'open' | 'ended';
  scheduledFor: string | null;
  expiresAt: string;
  maxMinutes: number;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  createdBy: string;
  /** Address to send to the student. */
  guestUrl: string;
}

export interface RtcJoin {
  appId: string;
  channel: string;
  token: string;
  uid: number;
  secondsLeft: number;
}

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);

@Injectable()
export class VideoService {
  /** Joins from one address, so the public join address cannot be used to hammer the database. */
  private readonly joinsPerAddress = new SlidingWindowLimiter(30, 60_000);
  private readonly badLinksPerAddress = new SlidingWindowLimiter(10, 60_000);

  constructor(
    private readonly db: DatabaseService,
    private readonly access: LeadAccess,
    private readonly writer: LeadWriter,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private requireConfigured(): { appId: string; certificate: string } {
    const appId = this.env.AGORA_APP_ID;
    const certificate = this.env.AGORA_APP_CERTIFICATE;
    if (!appId || !certificate) {
      throw AppError.conflict('VIDEO_NOT_CONFIGURED', 'Video counselling is not set up yet. Add AGORA_APP_ID and AGORA_APP_CERTIFICATE to the environment.');
    }
    return { appId, certificate };
  }

  /** Whether the feature is switched on, so the screen can hide the button instead of failing. */
  status(): { enabled: boolean } {
    return { enabled: Boolean(this.env.AGORA_APP_ID && this.env.AGORA_APP_CERTIFICATE) };
  }

  // ------------------------------------------------------------------ staff

  async create(auth: AuthContext, leadId: string, input: { scheduledFor?: string; maxMinutes: number }): Promise<VideoSessionView> {
    this.requireConfigured();
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const lead = await this.access.get(trx, auth, leadId);
      const now = new Date();
      const scheduled = input.scheduledFor ? new Date(input.scheduledFor) : null;
      if (scheduled && scheduled.getTime() < now.getTime() - 5 * 60_000) {
        throw AppError.badRequest('SCHEDULE_IN_PAST', 'Choose a time that has not passed', [{ field: 'scheduledFor', message: 'Choose a time that has not passed' }]);
      }
      // The student's link works until a day after the chosen start (or after now when there is none).
      const expires = new Date((scheduled ?? now).getTime() + LINK_HOURS * 3_600_000);
      const { rows } = await sql<{ id: string }>`
        INSERT INTO video_sessions (tenant_id, lead_id, created_by, scheduled_for, expires_at, max_minutes)
        VALUES (${auth.tenantId}, ${leadId}, ${auth.userId}, ${scheduled}, ${expires}, ${input.maxMinutes})
        RETURNING id`.execute(trx);
      const id = rows[0]!.id;
      await this.writer.activity(trx, {
        tenantId: auth.tenantId, leadId, userId: auth.userId, type: 'note',
        remark: `Video session ${scheduled ? `planned for ${scheduled.toISOString()}` : 'created'} by ${auth.name}`,
      });
      await this.audit.write(trx, {
        tenantId: auth.tenantId, actorId: auth.userId, action: 'video.create', entity: 'video_session', entityId: id,
        after: { leadNo: lead.lead_no, maxMinutes: input.maxMinutes }, ip: auth.ip, requestId: auth.requestId,
      });
      return this.view(await this.load(trx, id), auth.tenantId);
    });
  }

  list(auth: AuthContext, leadId: string): Promise<VideoSessionView[]> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      await this.access.get(trx, auth, leadId);
      const { rows } = await sql<SessionRow>`
        SELECT v.id, v.lead_id, v.created_by, v.scheduled_for, v.expires_at, v.max_minutes, v.status, v.started_at, v.ended_at, v.created_at, u.name AS creator_name
        FROM video_sessions v JOIN users u ON u.id = v.created_by
        WHERE v.lead_id = ${leadId} ORDER BY v.created_at DESC LIMIT 20`.execute(trx);
      return rows.map((r) => this.view(r, auth.tenantId));
    });
  }

  /** What a staff member needs to join: the session's channel and a short-lived token. */
  join(auth: AuthContext, sessionId: string): Promise<RtcJoin & { guestUrl: string }> {
    const cfg = this.requireConfigured();
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const session = await this.load(trx, sessionId, true);
      await this.access.get(trx, auth, session.lead_id);
      const started = await this.startIfFirst(trx, session);
      return { ...this.credentials(cfg, auth.tenantId, started), guestUrl: this.view(started, auth.tenantId).guestUrl };
    });
  }

  end(auth: AuthContext, sessionId: string): Promise<VideoSessionView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const session = await this.load(trx, sessionId, true);
      await this.access.get(trx, auth, session.lead_id);
      if (session.status === 'open') {
        await sql`UPDATE video_sessions SET status = 'ended', ended_at = GREATEST(now(), COALESCE(started_at, now())), ended_by = ${auth.userId} WHERE id = ${sessionId}`.execute(trx);
        await this.writer.activity(trx, {
          tenantId: auth.tenantId, leadId: session.lead_id, userId: auth.userId, type: 'note', remark: `Video session ended by ${auth.name}`,
        });
      }
      return this.view(await this.load(trx, sessionId), auth.tenantId);
    });
  }

  /**
   * Video use this month. The limit is in Agora's own unit (Standard minutes) so it can be compared with
   * the package; the call-minute figures are the same numbers in plain terms, for the screen.
   */
  usage(auth: AuthContext): Promise<{ usedStandardMinutes: number; limitStandardMinutes: number | null; callMinutesUsed: number; callMinutesLimit: number | null }> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const callMinutes = await this.callMinutesUsed(trx);
      const limit = this.env.VIDEO_MONTHLY_MINUTE_LIMIT || null;
      return {
        usedStandardMinutes: callMinutes * STANDARD_PER_CALL_MINUTE,
        limitStandardMinutes: limit,
        callMinutesUsed: callMinutes,
        callMinutesLimit: limit ? Math.floor(limit / STANDARD_PER_CALL_MINUTE) : null,
      };
    });
  }

  // ---------------------------------------------------------------- student

  /** The student's way in. The link alone is the credential, so it is checked and rate-limited with care. */
  async guestJoin(link: string, ip: string): Promise<RtcJoin & { counsellorName: string; companyName: string; firstName: string }> {
    const wait = this.joinsPerAddress.hit(ip);
    if (wait) throw new AppError('RATE_LIMITED', 'Too many tries. Please wait a moment.', 429, undefined, { 'retry-after': String(wait) });
    const cfg = this.requireConfigured();
    const parsed = readGuestToken(this.env.JWT_ACCESS_SECRET, link);
    if (!parsed) {
      const slow = this.badLinksPerAddress.hit(ip);
      if (slow) throw new AppError('RATE_LIMITED', 'Too many tries. Please wait a moment.', 429, undefined, { 'retry-after': String(slow) });
      throw AppError.notFound('Video session');
    }
    return this.db.withTenant(parsed.tenantId, async (trx) => {
      const session = await this.load(trx, parsed.sessionId, true).catch(() => null);
      if (!session) throw AppError.notFound('Video session');
      const started = await this.startIfFirst(trx, session);
      const { rows } = await sql<{ counsellor: string; company: string; first: string }>`
        SELECT u.name AS counsellor, t.name AS company, split_part(l.name, ' ', 1) AS first
        FROM video_sessions v JOIN users u ON u.id = v.created_by JOIN tenants t ON t.id = v.tenant_id JOIN leads l ON l.id = v.lead_id
        WHERE v.id = ${session.id}`.execute(trx);
      return {
        ...this.credentials(cfg, parsed.tenantId, started),
        counsellorName: rows[0]?.counsellor ?? '',
        companyName: rows[0]?.company ?? '',
        firstName: rows[0]?.first ?? '',
      };
    });
  }

  // ---------------------------------------------------------------- helpers

  private async load(trx: Trx, id: string, lock = false): Promise<SessionRow> {
    const { rows } = await sql<SessionRow>`
      SELECT v.id, v.lead_id, v.created_by, v.scheduled_for, v.expires_at, v.max_minutes, v.status, v.started_at, v.ended_at, v.created_at, u.name AS creator_name
      FROM video_sessions v JOIN users u ON u.id = v.created_by
      WHERE v.id = ${id} ${lock ? sql`FOR UPDATE OF v` : sql``}`.execute(trx);
    if (!rows[0]) throw AppError.notFound('Video session');
    return rows[0];
  }

  /**
   * Refuses a session that is over, and starts the clock when the first person arrives. Starting is
   * also where the monthly limit is checked, so a session already running is never cut off by it.
   */
  private async startIfFirst(trx: Trx, session: SessionRow): Promise<SessionRow> {
    const problem = sessionProblem(session, new Date());
    if (problem === 'ended') throw AppError.conflict('SESSION_ENDED', 'This video session has ended.');
    // Not marked as ended here: the throw would undo it. The clock alone decides, and usage is capped by it.
    if (problem === 'time_up') throw AppError.conflict('SESSION_ENDED', 'The time for this video session is over.');
    if (problem === 'link_expired') throw AppError.conflict('LINK_EXPIRED', 'This link has expired. Ask your counsellor for a new one.');
    if (session.started_at) return session;

    const limit = this.env.VIDEO_MONTHLY_MINUTE_LIMIT;
    if (limit > 0 && ((await this.callMinutesUsed(trx)) + session.max_minutes) * STANDARD_PER_CALL_MINUTE > limit) {
      throw AppError.conflict('VIDEO_LIMIT_REACHED', 'The video minutes for this month are used up. Please try again next month or use a phone call.');
    }
    await sql`UPDATE video_sessions SET started_at = now() WHERE id = ${session.id} AND started_at IS NULL`.execute(trx);
    return this.load(trx, session.id);
  }

  private credentials(cfg: { appId: string; certificate: string }, tenantId: string, s: SessionRow): RtcJoin {
    const uid = randomUid(randomInt);
    const left = secondsLeft(s, new Date());
    const channel = channelOf(s.id);
    return { appId: cfg.appId, channel, uid, secondsLeft: left, token: buildRtcToken(cfg.appId, cfg.certificate, channel, uid, left) };
  }

  /**
   * Minutes of video calls this month, an upper bound: every session counts from its start to its end
   * (or to its planned end if nobody ended it).
   */
  private async callMinutesUsed(trx: Trx): Promise<number> {
    const { rows } = await sql<{ minutes: number }>`
      SELECT COALESCE(SUM(CEIL(EXTRACT(EPOCH FROM (
               LEAST(COALESCE(v.ended_at, v.started_at + v.max_minutes * interval '1 minute'), v.started_at + v.max_minutes * interval '1 minute', now()) - v.started_at)) / 60)), 0)::int AS minutes
      FROM video_sessions v JOIN tenants t ON t.id = v.tenant_id
      WHERE v.started_at >= (date_trunc('month', now() AT TIME ZONE t.timezone) AT TIME ZONE t.timezone)`.execute(trx);
    return rows[0]?.minutes ?? 0;
  }

  private view(r: SessionRow, tenantId: string): VideoSessionView {
    return {
      id: r.id,
      leadId: r.lead_id,
      status: r.status as 'open' | 'ended',
      scheduledFor: iso(r.scheduled_for),
      expiresAt: new Date(r.expires_at).toISOString(),
      maxMinutes: r.max_minutes,
      startedAt: iso(r.started_at),
      endedAt: iso(r.ended_at),
      createdAt: new Date(r.created_at).toISOString(),
      createdBy: r.creator_name,
      guestUrl: `${this.env.WEB_URL.replace(/\/$/, '')}/meet/${guestToken(this.env.JWT_ACCESS_SECRET, tenantId, r.id)}`,
    };
  }
}
