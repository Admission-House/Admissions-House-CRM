import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import type { AuthContext } from '../auth/auth-context.js';
import { AuditService } from '../audit/audit.service.js';
import { AppError } from '../common/app-error.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DatabaseService, Trx } from '../database/database.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { FileLinks } from '../storage/file-links.service.js';
import { buildRtcToken, channelOf, secondsLeft, type SessionKind } from '../video/video-rules.js';
import { VideoStore } from '../video/video-store.js';
import { AgoraError, AgoraRecordingClient } from './agora-recording.client.js';
import { RecordingStorage } from './recording-storage.js';
import { actionForNotice, classifyFile, filePrefixFor, filesFromServerResponse, isLive, kindOf, REASON, startBody, type RecordingStatus, statusBeforeAnyRecording, type SessionRecordingStatus } from './recording-rules.js';

export type PolicyMode = 'off' | 'optional' | 'always';

export interface PolicyView {
  mode: PolicyMode;
  retentionDays: number;
  noticeText: string;
  version: number;
  /** Whether the server has everything it needs to record. When false, sessions are not recorded whatever the mode. */
  ready: boolean;
  /** The settings still empty, shown only to those who manage the policy. */
  missing?: string[];
}

export interface RecordingFileView {
  id: string;
  kind: 'audio' | 'video' | 'audio_and_video';
  format: 'mp4' | 'mp3' | 'm3u8' | 'ts';
  sizeBytes: number | null;
  playable: boolean;
}

export interface RecordingView {
  id: string;
  status: RecordingStatus;
  failureReason: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  availableAt: string | null;
  expiresAt: string | null;
  files: RecordingFileView[];
  canPlay: boolean;
  canDownload: boolean;
}

export type { SessionRecordingStatus } from './recording-rules.js';

interface RecRow {
  id: string;
  tenant_id: string;
  session_id: string;
  status: RecordingStatus;
  bot_uid: number;
  stream_types: number;
  resource_id: string | null;
  sid: string | null;
  file_prefix: string;
  retention_days: number;
  attempts: number;
  stop_requested_at: Date | null;
  stopped_at: Date | null;
  last_attempt_at: Date | null;
}

interface SessionFacts {
  id: string;
  kind: SessionKind;
  status: 'open' | 'ended';
  started_at: Date | null;
  max_minutes: number;
  created_by: string;
  title: string | null;
}

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);
const MAX_START_ATTEMPTS = 3;
const MAX_STOP_ATTEMPTS = 3;
/** How long a stopped recording may wait for its file to show up in the bucket. */
const FILE_WAIT_MINUTES = 30;
const DEFAULT_NOTICE = 'This session may be recorded so that it can be reviewed later by the company. By joining you agree to the recording. If you do not agree, please do not join.';

@Injectable()
export class RecordingService {
  private readonly logger = new Logger(RecordingService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly agora: AgoraRecordingClient,
    private readonly storage: RecordingStorage,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly links: FileLinks,
    private readonly store: VideoStore,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Whether the server has everything it needs to record. */
  ready(): boolean {
    return this.agora.configured();
  }

  // ------------------------------------------------------------------ policy

  /** The company's recording policy, made with its defaults the first time it is asked for. */
  async policy(trx: Trx, tenantId: string): Promise<Omit<PolicyView, 'ready' | 'missing'>> {
    const { rows } = await sql<{ mode: PolicyMode; retention_days: number; notice_text: string; version: number }>`
      INSERT INTO recording_policies (tenant_id, notice_text) VALUES (${tenantId}, ${DEFAULT_NOTICE})
      ON CONFLICT (tenant_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id
      RETURNING mode, retention_days, notice_text, version`.execute(trx);
    const r = rows[0]!;
    return { mode: r.mode, retentionDays: r.retention_days, noticeText: r.notice_text, version: r.version };
  }

  async getPolicy(auth: AuthContext): Promise<PolicyView> {
    return this.db.withTenant(auth.tenantId, async (trx) => ({
      ...(await this.policy(trx, auth.tenantId)),
      ready: this.ready(),
      ...(auth.permissions.has('recording.manage') ? { missing: this.agora.missing() } : {}),
    }));
  }

  /** Changes the policy. A new notice or mode is a new version, so every session says which one it was made under. */
  async updatePolicy(auth: AuthContext, input: { mode?: PolicyMode; retentionDays?: number; noticeText?: string }): Promise<PolicyView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const before = await this.policy(trx, auth.tenantId);
      const mode = input.mode ?? before.mode;
      const retention = input.retentionDays ?? before.retentionDays;
      const notice = input.noticeText ?? before.noticeText;
      const changesMeaning = mode !== before.mode || notice !== before.noticeText;
      await sql`
        UPDATE recording_policies SET mode = ${mode}, retention_days = ${retention}, notice_text = ${notice},
               version = version + ${changesMeaning ? 1 : 0}, updated_by = ${auth.userId}
        WHERE tenant_id = ${auth.tenantId}`.execute(trx);
      await this.audit.write(trx, {
        tenantId: auth.tenantId, actorId: auth.userId, action: 'recording.policy', entity: 'recording_policy',
        before: { mode: before.mode, retentionDays: before.retentionDays, version: before.version }, after: { mode, retentionDays: retention, noticeChanged: notice !== before.noticeText },
        ip: auth.ip, requestId: auth.requestId,
      });
      return { ...(await this.policy(trx, auth.tenantId)), ready: this.ready(), missing: this.agora.missing() };
    });
  }

  // ------------------------------------------------- what the video code asks

  /**
   * Whether a session being made will be recorded. Only if the policy says so AND the server can actually record:
   * promising a recording that cannot happen would be worse than saying plainly that it will not be made.
   */
  async decideForNewSession(trx: Trx, tenantId: string, hostWants: boolean | undefined): Promise<{ enabled: boolean; version: number | null; note: 'off' | 'unavailable' | null }> {
    const p = await this.policy(trx, tenantId);
    const wanted = p.mode === 'always' || (p.mode === 'optional' && hostWants === true);
    if (!wanted) return { enabled: false, version: null, note: p.mode === 'off' ? 'off' : null };
    if (!this.ready()) return { enabled: false, version: null, note: 'unavailable' };
    return { enabled: true, version: p.version, note: null };
  }

  /**
   * A person joining a recorded session has to have agreed to the notice. Asked before anything else happens,
   * so a refusal leaves no trace except the refusal itself. The agreement is kept with the time and the version.
   */
  async requireConsent(trx: Trx, s: { id: string; tenant_id: string; recording_enabled: boolean; recording_policy_version: number | null }, invite: { id: string; consented_at: Date | null }, agreed: boolean | undefined): Promise<void> {
    if (!s.recording_enabled || invite.consented_at) return;
    const p = await this.policy(trx, s.tenant_id);
    if (agreed !== true) {
      throw new AppError('CONSENT_REQUIRED', 'This session is recorded. Please read the notice and agree to join.', 409, undefined, undefined, { notice: p.noticeText, version: s.recording_policy_version ?? p.version });
    }
    await sql`UPDATE video_session_invites SET consented_at = now(), consent_notice_version = ${s.recording_policy_version ?? p.version} WHERE id = ${invite.id}::uuid`.execute(trx);
    await this.store.event(trx, s.tenant_id, s.id, invite.id, 'consent', `agreed to the recording notice, version ${s.recording_policy_version ?? p.version}`);
  }

  /**
   * Makes sure a started session that is meant to be recorded has a recording on its way: one live recording at
   * most (the database refuses a second), and a new one if the last ended early (for example the channel sat
   * empty) while the session carries on.
   */
  async ensureRecording(trx: Trx, s: SessionFacts & { tenant_id: string; recording_enabled: boolean; recording_policy_version: number | null }): Promise<boolean> {
    if (!s.recording_enabled || s.status !== 'open' || !s.started_at) return false;
    const { rows } = await sql<{ status: RecordingStatus; failure_reason: string | null; age: number }>`
      SELECT status, failure_reason, EXTRACT(EPOCH FROM now() - created_at)::int AS age FROM session_recordings
      WHERE session_id = ${s.id}::uuid ORDER BY created_at DESC LIMIT 1`.execute(trx);
    const last = rows[0];
    if (last && isLive(last.status)) return false; // an earlier part is still being looked after; a finished one means the rest of an open session needs a new part
    if (last && last.age < 120) return false; // never more often than every two minutes, so a failing start does not loop
    const p = await this.policy(trx, s.tenant_id);
    const prefix = filePrefixFor(s.tenant_id, s.id) + (last ? `/part${(await this.partCount(trx, s.id)) + 1}` : '');
    const botUid = await this.freeBotUid(trx, s.id);
    const stream = s.kind === 'voice' ? 0 : 2;
    try {
      await sql`
        INSERT INTO session_recordings (tenant_id, session_id, bot_uid, stream_types, file_prefix, policy_version, retention_days)
        VALUES (${s.tenant_id}, ${s.id}::uuid, ${botUid}, ${stream}, ${prefix}, ${s.recording_policy_version ?? p.version}, ${p.retentionDays})`.execute(trx);
    } catch (err) {
      // Another request made the live recording a moment ago: the database allows one, and that is enough.
      if ((err as { code?: string }).code === '23505') return false;
      throw err;
    }
    return true;
  }

  private async partCount(trx: Trx, sessionId: string): Promise<number> {
    const { rows } = await sql<{ n: string }>`SELECT count(*) AS n FROM session_recordings WHERE session_id = ${sessionId}::uuid`.execute(trx);
    return Number(rows[0]?.n ?? 0);
  }

  /** The recorder is a member of the channel; its number must not be anyone else's. */
  private async freeBotUid(trx: Trx, sessionId: string): Promise<number> {
    for (;;) {
      const uid = 1 + randomInt(2_147_483_646);
      const { rows } = await sql`
        SELECT 1 FROM video_session_invites WHERE session_id = ${sessionId}::uuid AND agora_uid = ${uid}
        UNION ALL SELECT 1 FROM session_recordings WHERE session_id = ${sessionId}::uuid AND bot_uid = ${uid}`.execute(trx);
      if (rows.length === 0) return uid;
    }
  }

  /** After a transaction: look after whatever is due now, without making the person who caused it wait. */
  kick(tenantId: string): void {
    if (this.env.COMMUNICATION_SWEEP_SEC <= 0) return; // switched off (tests): the sweep is called by hand
    setImmediate(() => void this.sweep(tenantId).catch((e: unknown) => this.logger.error(`recording work failed: ${e instanceof Error ? e.message : String(e)}`)));
  }

  // ------------------------------------------------------------------ work

  /** One pass over a company's recordings: start what is waiting, stop what should stop, check what is done. */
  async sweep(tenantId: string): Promise<{ started: number; stopped: number; checked: number; expired: number }> {
    const out = { started: 0, stopped: 0, checked: 0, expired: 0 };
    const ids = await this.db.withTenant(tenantId, async (trx) => {
      // A start that was begun and never confirmed (the server stopped in between) cannot be resumed safely.
      const lost = await sql<{ id: string; session_id: string }>`
        UPDATE session_recordings SET status = 'failed', failure_reason = ${REASON.startNotConfirmed}, stopped_at = now()
        WHERE status = 'starting' AND sid IS NULL AND last_attempt_at < now() - interval '90 seconds' RETURNING id, session_id`.execute(trx);
      for (const l of lost.rows) await this.failureNotice(trx, tenantId, l.session_id, REASON.startNotConfirmed);
      const { rows } = await sql<{ id: string; status: RecordingStatus }>`
        SELECT r.id, r.status FROM session_recordings r JOIN video_sessions v ON v.id = r.session_id
        WHERE (r.status = 'pending' AND (r.last_attempt_at IS NULL OR r.last_attempt_at < now() - make_interval(secs => r.attempts * 15)))
           OR (r.status = 'stopping' AND (r.last_attempt_at IS NULL OR r.last_attempt_at < now() - interval '15 seconds'))
           OR (r.status = 'recording' AND (v.status = 'ended' OR r.last_attempt_at IS NULL OR r.last_attempt_at < now() - interval '60 seconds'))
           OR (r.status = 'processing' AND (r.last_attempt_at IS NULL OR r.last_attempt_at < now() - interval '30 seconds'))
        ORDER BY r.created_at LIMIT 50`.execute(trx);
      return rows;
    });
    for (const r of ids) {
      try {
        if (r.status === 'pending') out.started += (await this.start(tenantId, r.id)) ? 1 : 0;
        else if (r.status === 'stopping') out.stopped += (await this.stop(tenantId, r.id)) ? 1 : 0;
        else if (r.status === 'recording') await this.checkRunning(tenantId, r.id);
        else out.checked += (await this.verify(tenantId, r.id)) ? 1 : 0;
      } catch (err) {
        this.logger.error(`recording ${r.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    out.expired = await this.purgeExpired(tenantId);
    return out;
  }

  private async claim(tenantId: string, id: string, from: RecordingStatus, to: RecordingStatus | null): Promise<{ rec: RecRow; session: SessionFacts } | null> {
    return this.db.withTenant(tenantId, async (trx) => {
      const { rows } = await sql<RecRow>`
        UPDATE session_recordings SET last_attempt_at = now(), attempts = attempts + ${to === 'starting' || to === 'stopping' || from === 'stopping' ? 1 : 0}${to ? sql`, status = ${to}` : sql``}
        WHERE id = ${id}::uuid AND status = ${from}
        RETURNING id, tenant_id, session_id, status, bot_uid, stream_types, resource_id, sid, file_prefix, retention_days, attempts, stop_requested_at, stopped_at, last_attempt_at`.execute(trx);
      if (!rows[0]) return null;
      const { rows: s } = await sql<SessionFacts>`SELECT id, kind, status, started_at, max_minutes, created_by, title FROM video_sessions WHERE id = ${rows[0].session_id}::uuid`.execute(trx);
      return { rec: rows[0], session: s[0]! };
    });
  }

  private async failureNotice(trx: Trx, tenantId: string, sessionId: string, reason: string): Promise<void> {
    const { rows } = await sql<{ created_by: string; title: string | null; kind: string }>`SELECT created_by, title, kind FROM video_sessions WHERE id = ${sessionId}::uuid`.execute(trx);
    const s = rows[0];
    await this.store.event(trx, tenantId, sessionId, null, 'recording', `failed: ${reason}`);
    if (s) await this.store.notify(trx, tenantId, [s.created_by], 'comm_recording_failed', { sessionId, title: s.title ?? undefined, kind: s.kind, reason });
  }

  /** Asks Agora to start. Returns true when it is recording. */
  private async start(tenantId: string, id: string): Promise<boolean> {
    const claimed = await this.claim(tenantId, id, 'pending', 'starting');
    if (!claimed) return false;
    const { rec, session } = claimed;
    const fail = (reason: string, retry: boolean) =>
      this.db.withTenant(tenantId, async (trx) => {
        const giveUp = !retry || rec.attempts >= MAX_START_ATTEMPTS;
        if (giveUp) {
          await sql`UPDATE session_recordings SET status = 'failed', failure_reason = ${reason}, stopped_at = now() WHERE id = ${id}::uuid`.execute(trx);
          await this.failureNotice(trx, tenantId, rec.session_id, reason);
        } else {
          await sql`UPDATE session_recordings SET status = 'pending' WHERE id = ${id}::uuid`.execute(trx);
        }
        return false;
      });

    if (session.status === 'ended') return fail(REASON.endedEarly, false);
    if (!this.ready()) return fail(REASON.notSetUp, false);
    try {
      const channel = channelOf(session.id);
      const left = Math.min(86_400, Math.max(120, secondsLeft(session, new Date())));
      const token = buildRtcToken(this.env.AGORA_APP_ID!, this.env.AGORA_APP_CERTIFICATE!, channel, rec.bot_uid, left);
      const prefix = rec.file_prefix;
      const resourceId = await this.agora.acquire(channel, rec.bot_uid);
      const sid = await this.agora.start(resourceId, startBody({ channel, botUid: rec.bot_uid, token, voice: rec.stream_types === 0, prefix, storage: this.agora.storageForAgora(), maxIdleSeconds: this.env.RECORDING_MAX_IDLE_SECONDS }));
      await this.db.withTenant(tenantId, async (trx) => {
        // If the session ended while Agora was being asked, go straight on to stopping.
        await sql`
          UPDATE session_recordings SET resource_id = ${resourceId}, sid = ${sid}, started_at = now(),
                 status = CASE WHEN stop_requested_at IS NOT NULL THEN 'stopping' ELSE 'recording' END, failure_reason = NULL
          WHERE id = ${id}::uuid`.execute(trx);
        await this.store.event(trx, tenantId, rec.session_id, null, 'recording', 'started');
      });
      return true;
    } catch (err) {
      const reason = err instanceof AgoraError ? `${REASON.startFailed} (${err.message.slice(0, 200)})` : `${REASON.startFailed} (${err instanceof Error ? err.message.slice(0, 200) : 'network error'})`;
      // A refusal from Agora will be refused again; only a network or server problem is worth another try.
      const retry = !(err instanceof AgoraError) || err.httpStatus >= 500;
      return fail(reason, retry);
    }
  }

  /** Stops a recording whose session is over. Returns true when Agora has stopped it (or it had already ended). */
  private async stop(tenantId: string, id: string): Promise<boolean> {
    const claimed = await this.claim(tenantId, id, 'stopping', null);
    if (!claimed) return false;
    const { rec } = claimed;
    if (!rec.sid || !rec.resource_id) {
      await this.toProcessing(tenantId, id);
      return true;
    }
    try {
      const answer = await this.agora.stop(rec.resource_id, rec.sid, channelOf(rec.session_id), rec.bot_uid);
      await this.toProcessing(tenantId, id, answer === 'gone' ? 'already ended' : `stopped, upload ${answer.uploadingStatus ?? 'status unknown'}`);
      return true;
    } catch (err) {
      this.logger.warn(`stop of recording ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
      // After a few tries, go on to looking for the file: Agora may have ended it by itself.
      if (rec.attempts >= MAX_STOP_ATTEMPTS) await this.toProcessing(tenantId, id, 'stop could not be confirmed');
      return false;
    }
  }

  private async toProcessing(tenantId: string, id: string, detail?: string): Promise<void> {
    await this.db.withTenant(tenantId, async (trx) => {
      const { rows } = await sql<{ session_id: string }>`
        UPDATE session_recordings SET status = 'processing', stopped_at = COALESCE(stopped_at, now()), last_attempt_at = NULL
        WHERE id = ${id}::uuid AND status IN ('stopping', 'recording', 'starting') RETURNING session_id`.execute(trx);
      if (rows[0]) await this.store.event(trx, tenantId, rows[0].session_id, null, 'recording', detail ?? 'stopped');
    });
  }

  /** Looks at a recording that is running: has Agora ended it, or is the session over and it must be stopped. */
  private async checkRunning(tenantId: string, id: string): Promise<void> {
    const claimed = await this.claim(tenantId, id, 'recording', null);
    if (!claimed) return;
    const { rec, session } = claimed;
    if (session.status === 'ended') {
      await this.db.withTenant(tenantId, (trx) => sql`UPDATE session_recordings SET status = 'stopping', stop_requested_at = COALESCE(stop_requested_at, now()), last_attempt_at = NULL WHERE id = ${id}::uuid AND status = 'recording'`.execute(trx));
      await this.stop(tenantId, id);
      return;
    }
    if (!rec.sid || !rec.resource_id) return;
    try {
      const q = await this.agora.query(rec.resource_id, rec.sid);
      if (q === 'gone' || q.status === 8) await this.toProcessing(tenantId, id, q === 'gone' ? 'the recorder ended (channel was empty for a while)' : 'the recorder exited');
      else if (q.status === 20) await this.toProcessing(tenantId, id, REASON.abnormalExit);
    } catch (err) {
      this.logger.warn(`query of recording ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Finds the finished files in the bucket and checks them. Only then is a recording "available". */
  private async verify(tenantId: string, id: string): Promise<boolean> {
    const claimed = await this.claim(tenantId, id, 'processing', null);
    if (!claimed) return false;
    const { rec, session } = claimed;
    let found: { key: string; size: number }[] = [];
    try {
      found = await this.storage.list(rec.file_prefix);
    } catch (err) {
      this.logger.warn(`could not list the bucket for recording ${id}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    const files = found.map((f) => ({ ...f, c: classifyFile(f.key) })).filter((f): f is typeof f & { c: NonNullable<typeof f.c> } => f.c !== null);
    const playable = files.filter((f) => f.c.playable && f.size > 0);
    if (playable.length === 0) {
      const waited = rec.stopped_at ? Date.now() - new Date(rec.stopped_at).getTime() : 0;
      if (waited > FILE_WAIT_MINUTES * 60_000) {
        await this.db.withTenant(tenantId, async (trx) => {
          await sql`UPDATE session_recordings SET status = 'failed', failure_reason = ${REASON.noFile} WHERE id = ${id}::uuid AND status = 'processing'`.execute(trx);
          await this.failureNotice(trx, tenantId, rec.session_id, REASON.noFile);
        });
      }
      return false;
    }
    await this.db.withTenant(tenantId, async (trx) => {
      for (const f of files) {
        await sql`
          INSERT INTO session_recording_files (tenant_id, recording_id, file_key, kind, format, size_bytes, is_playable, verified_at)
          VALUES (${tenantId}, ${id}::uuid, ${f.key}, ${kindOf(undefined, rec.stream_types === 0)}, ${f.c.format}, ${f.size}, ${f.c.playable && f.size > 0}, now())
          ON CONFLICT (recording_id, file_key) DO UPDATE SET size_bytes = EXCLUDED.size_bytes, is_playable = EXCLUDED.is_playable, verified_at = now()`.execute(trx);
      }
      const done = await sql`
        UPDATE session_recordings SET status = 'available', available_at = now(), expires_at = now() + make_interval(days => retention_days), failure_reason = NULL
        WHERE id = ${id}::uuid AND status = 'processing'`.execute(trx);
      if (Number(done.numAffectedRows ?? 0) === 0) return;
      await this.store.event(trx, tenantId, rec.session_id, null, 'recording', 'available');
      await this.store.notify(trx, tenantId, [session.created_by], 'comm_recording_ready', { sessionId: rec.session_id, title: session.title ?? undefined, kind: session.kind });
      await this.audit.write(trx, { tenantId, actorId: null, action: 'recording.available', entity: 'communication', entityId: rec.session_id, after: { recording: id, files: playable.length } });
    });
    return true;
  }

  /** Removes recordings that have been kept for as long as the policy said. */
  private async purgeExpired(tenantId: string): Promise<number> {
    const due = await this.db.withTenant(tenantId, async (trx) => {
      const { rows } = await sql<{ id: string; session_id: string }>`
        SELECT id, session_id FROM session_recordings WHERE status = 'available' AND expires_at < now() ORDER BY expires_at LIMIT 20 FOR UPDATE SKIP LOCKED`.execute(trx);
      return rows;
    });
    let n = 0;
    for (const r of due) {
      try {
        const files = await this.db.withTenant(tenantId, async (trx) => (await sql<{ file_key: string }>`SELECT file_key FROM session_recording_files WHERE recording_id = ${r.id}::uuid`.execute(trx)).rows);
        for (const f of files) await this.storage.delete(f.file_key);
        await this.db.withTenant(tenantId, async (trx) => {
          await sql`UPDATE session_recording_files SET is_playable = false WHERE recording_id = ${r.id}::uuid`.execute(trx);
          await sql`UPDATE session_recordings SET status = 'expired' WHERE id = ${r.id}::uuid AND status = 'available'`.execute(trx);
          await this.store.event(trx, tenantId, r.session_id, null, 'recording', 'removed after the retention period');
          await this.audit.write(trx, { tenantId, actorId: null, action: 'recording.expire', entity: 'communication', entityId: r.session_id, after: { recording: r.id } });
        });
        n++;
      } catch (err) {
        this.logger.warn(`could not remove recording ${r.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return n;
  }

  // ----------------------------------------------------------------- notices

  /** Checks Agora's signature over the exact bytes received (Agora-Signature-V2, HMAC-SHA256, hex). */
  verifySignature(raw: Buffer, signature: string | undefined): boolean {
    const secret = this.env.AGORA_WEBHOOK_SECRET;
    if (!secret || !signature) return false;
    const expected = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'));
    const given = Buffer.from(signature.trim().toLowerCase());
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  /**
   * A notice from Agora. It is checked, filed once (a repeat does nothing), and acted on inside the company's own
   * scope. Notices about recordings we do not know are accepted and ignored, so Agora does not keep retrying them.
   */
  async handleNotice(raw: Buffer, signature: string | undefined): Promise<{ ok: true; duplicate?: boolean; ignored?: boolean }> {
    if (!this.verifySignature(raw, signature)) throw new AppError('SIGNATURE_INVALID', 'The signature does not match', 401);
    let body: { noticeId?: unknown; productId?: unknown; eventType?: unknown; payload?: { sid?: unknown; details?: Record<string, unknown> } };
    try {
      body = JSON.parse(raw.toString('utf8')) as typeof body;
    } catch {
      throw AppError.badRequest('INVALID_NOTICE', 'The notice is not valid JSON');
    }
    const sid = body.payload?.sid;
    if (typeof body.noticeId !== 'string' || typeof body.eventType !== 'number' || typeof sid !== 'string') return { ok: true, ignored: true };
    const { rows } = await sql<{ tenant_id: string; recording_id: string }>`SELECT tenant_id, recording_id FROM resolve_recording_by_sid(${sid})`.execute(this.db.unscoped());
    const known = rows[0];
    if (!known) return { ok: true, ignored: true };
    const action = actionForNotice(body.eventType, body.payload?.details);
    const outcome = await this.db.withTenant(known.tenant_id, async (trx) => {
      const filed = await sql`
        INSERT INTO recording_webhook_events (tenant_id, notice_id, recording_id, event_type, detail)
        VALUES (${known.tenant_id}, ${body.noticeId as string}, ${known.recording_id}::uuid, ${body.eventType as number}, ${action.kind === 'ignore' ? null : action.kind})
        ON CONFLICT DO NOTHING`.execute(trx);
      if (Number(filed.numAffectedRows ?? 0) === 0) return 'duplicate' as const;
      const { rows: r } = await sql<{ session_id: string; status: RecordingStatus }>`SELECT session_id, status FROM session_recordings WHERE id = ${known.recording_id}::uuid FOR UPDATE`.execute(trx);
      const rec = r[0];
      if (!rec) return 'done' as const;
      if (action.kind === 'check_files' && rec.status === 'processing') {
        await sql`UPDATE session_recordings SET last_attempt_at = NULL WHERE id = ${known.recording_id}::uuid`.execute(trx);
      } else if (action.kind === 'ended' && ['recording', 'starting', 'stopping'].includes(rec.status)) {
        await sql`UPDATE session_recordings SET status = 'processing', stopped_at = COALESCE(stopped_at, now()), last_attempt_at = NULL WHERE id = ${known.recording_id}::uuid`.execute(trx);
        await this.store.event(trx, known.tenant_id, rec.session_id, null, 'recording', action.abnormal ? REASON.abnormalExit : 'the recorder ended');
      } else if (action.kind === 'failed' && rec.status !== 'available' && rec.status !== 'failed' && rec.status !== 'expired') {
        await sql`UPDATE session_recordings SET status = 'failed', failure_reason = ${action.reason}, stopped_at = COALESCE(stopped_at, now()) WHERE id = ${known.recording_id}::uuid`.execute(trx);
        await this.failureNotice(trx, known.tenant_id, rec.session_id, action.reason);
      }
      return 'done' as const;
    });
    if (outcome === 'duplicate') return { ok: true, duplicate: true };
    this.kick(known.tenant_id);
    return { ok: true };
  }

  // ----------------------------------------------------------------- reading

  /** What a session shows about its recording, for the screens and the history filters. */
  async statusOf(trx: Trx, session: { id: string; recording_enabled: boolean; recording_unavailable?: boolean }): Promise<SessionRecordingStatus> {
    const { rows } = await sql<{ status: RecordingStatus }>`SELECT status FROM session_recordings WHERE session_id = ${session.id}::uuid ORDER BY created_at DESC LIMIT 1`.execute(trx);
    if (rows[0]) return rows[0].status;
    return statusBeforeAnyRecording(session);
  }

  async forSession(auth: AuthContext, sessionId: string): Promise<{ status: SessionRecordingStatus; recordings: RecordingView[] }> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const session = await this.store.load(trx, sessionId, { auth });
      const { rows } = await sql<{ id: string; status: RecordingStatus; failure_reason: string | null; started_at: Date | null; stopped_at: Date | null; available_at: Date | null; expires_at: Date | null }>`
        SELECT id, status, failure_reason, started_at, stopped_at, available_at, expires_at FROM session_recordings WHERE session_id = ${sessionId}::uuid ORDER BY created_at`.execute(trx);
      const recordings: RecordingView[] = [];
      for (const r of rows) {
        const { rows: files } = await sql<{ id: string; kind: RecordingFileView['kind']; format: RecordingFileView['format']; size_bytes: string | null; is_playable: boolean }>`
          SELECT id, kind, format, size_bytes::text, is_playable FROM session_recording_files WHERE recording_id = ${r.id}::uuid ORDER BY format`.execute(trx);
        recordings.push({
          id: r.id, status: r.status, failureReason: r.failure_reason, startedAt: iso(r.started_at), stoppedAt: iso(r.stopped_at), availableAt: iso(r.available_at), expiresAt: iso(r.expires_at),
          files: files.map((f) => ({ id: f.id, kind: f.kind, format: f.format, sizeBytes: f.size_bytes === null ? null : Number(f.size_bytes), playable: f.is_playable })),
          canPlay: auth.permissions.has('recording.play') && r.status === 'available',
          canDownload: auth.permissions.has('recording.download') && r.status === 'available',
        });
      }
      const status: SessionRecordingStatus = recordings.length ? recordings[recordings.length - 1]!.status : statusBeforeAnyRecording(session);
      return { status, recordings };
    });
  }

  /**
   * A short-lived link to one recording file, for whoever may see the session and holds the permission. Asking for
   * it is written to the audit log: who listened to or saved which recording, and when.
   */
  async link(auth: AuthContext, sessionId: string, fileId: string, purpose: 'play' | 'download'): Promise<{ url: string; expiresAt: string }> {
    const need = purpose === 'play' ? 'recording.play' : 'recording.download';
    if (!auth.permissions.has(need)) throw AppError.forbidden();
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const session = await this.store.load(trx, sessionId, { auth });
      const { rows } = await sql<{ id: string; format: string; recording_id: string }>`
        SELECT f.id, f.format, f.recording_id FROM session_recording_files f JOIN session_recordings r ON r.id = f.recording_id
        WHERE f.id = ${fileId}::uuid AND r.session_id = ${sessionId}::uuid AND r.status = 'available' AND f.is_playable`.execute(trx);
      const file = rows[0];
      if (!file) throw AppError.notFound('Recording');
      const day = new Date().toISOString().slice(0, 10);
      const name = `${(session.title ?? (session.lead_name ? `call with ${session.lead_name}` : 'call')).replace(/[^\w .-]/g, '_').slice(0, 60)} ${day}.${file.format}`;
      const signed = this.links.sign({ key: `rec:${auth.tenantId}:${file.id}:${purpose}`, type: file.format === 'mp3' ? 'audio/mpeg' : 'video/mp4', name }, 300);
      await this.audit.write(trx, {
        tenantId: auth.tenantId, actorId: auth.userId, action: purpose === 'play' ? 'recording.play' : 'recording.download', entity: 'communication', entityId: sessionId,
        after: { recording: file.recording_id, file: file.id }, ip: auth.ip, requestId: auth.requestId,
      });
      return { url: `/api/v1/recordings/files/${signed.token}`, expiresAt: signed.expiresAt.toISOString() };
    });
  }

  /** The file behind a signed link, for streaming. Only a link made by `link` works, until it expires. */
  async openLink(token: string, range?: { start: number; end: number }): Promise<{ stream: NodeJS.ReadableStream; size: number; total: number; type: string; name: string; download: boolean; partial: boolean }> {
    const checked = this.links.verify(token);
    if (!checked.ok) throw new AppError(checked.reason === 'expired' ? 'LINK_EXPIRED' : 'LINK_INVALID', checked.reason === 'expired' ? 'This link has expired. Ask for a new one.' : 'This link is not valid.', 403);
    const m = /^rec:([0-9a-f-]{36}):([0-9a-f-]{36}):(play|download)$/.exec(checked.claims.key);
    if (!m) throw new AppError('LINK_INVALID', 'This link is not valid.', 403);
    const [, tenantId, fileId, purpose] = m;
    const key = await this.db.withTenant(tenantId!, async (trx) => {
      const { rows } = await sql<{ file_key: string }>`
        SELECT f.file_key FROM session_recording_files f JOIN session_recordings r ON r.id = f.recording_id
        WHERE f.id = ${fileId!}::uuid AND r.status = 'available' AND f.is_playable`.execute(trx);
      return rows[0]?.file_key;
    });
    if (!key) throw AppError.notFound('Recording');
    const file = await this.storage.get(key, range);
    if (!file) throw AppError.notFound('Recording');
    return { stream: file.stream, size: file.size, total: file.total, type: checked.claims.type, name: checked.claims.name, download: purpose === 'download', partial: Boolean(range) };
  }
}

export { filesFromServerResponse };
