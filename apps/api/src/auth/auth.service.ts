import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { AttendanceRepository } from '../attendance/attendance.repository.js';
import { AuditService } from '../audit/audit.service.js';
import { AppError } from '../common/app-error.js';
import { SlidingWindowLimiter } from '../common/rate-limiter.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DatabaseService, Trx } from '../database/database.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type { AuthContext, RoleKey } from './auth-context.js';
import { AuthRepository, LoginUser } from './auth.repository.js';
import type { LoginInput } from './dto/auth.dto.js';
import { evaluateOffice, normalizeIp, OfficeFailure } from './office-rules.js';
import { passwordProblem, PasswordService } from './password.service.js';
import { hashToken, safeEqualHex, TokenService } from './token.service.js';

export interface RequestMeta {
  ip: string;
  userAgent: string | null;
  requestId: string;
}

export interface SignedIn {
  accessToken: string;
  expiresIn: number;
  /** Always present here; the controller decides whether it goes in a cookie or the response body. */
  refreshToken: string;
  clientType: 'web' | 'mobile';
}

export interface LoginResult extends SignedIn {
  mustChangePassword: boolean;
  user: { id: string; name: string; email: string; role: { key: RoleKey | null; name: string } };
}

/**
 * Expected failures are returned, not thrown, from inside a transaction. A thrown error would roll
 * the transaction back and lose the very record we need to keep: the failed attempt, the lock
 * counter, or the ended session. The caller commits first and throws afterwards.
 */
type Outcome<T> = { ok: true; value: T } | { ok: false; error: AppError };
const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
const fail = (error: AppError): Outcome<never> => ({ ok: false, error });
const unwrap = <T>(outcome: Outcome<T>): T => {
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
};

const INVALID_CREDENTIALS = () =>
  new AppError('INVALID_CREDENTIALS', 'The email or password is not correct', 401);

const OFFICE_MESSAGES: Record<OfficeFailure, string> = {
  network: 'You can sign in only from the office.',
  gps_far: 'You can sign in only from the office.',
  gps_missing: 'Turn on location and try again.',
  gps_inaccurate: 'Your location is not accurate enough. Move closer to a window and try again.',
  gps_mocked: 'Your location could not be verified.',
  not_configured: 'Office sign-in is not set up yet. Please contact your administrator.',
};

interface TenantRow {
  id: string;
  name: string;
  status: string;
}

@Injectable()
export class AuthService {
  private readonly addressLimiter: SlidingWindowLimiter;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DatabaseService,
    private readonly repo: AuthRepository,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly attendance: AttendanceRepository,
    private readonly notifications: NotificationsService,
  ) {
    this.addressLimiter = new SlidingWindowLimiter(env.LOGIN_IP_MAX_ATTEMPTS * 2, 10 * 60_000);
  }

  // ---------------------------------------------------------------- sign in

  async login(input: LoginInput, meta: RequestMeta): Promise<LoginResult> {
    const wait = this.addressLimiter.hit(meta.ip);
    if (wait) throw this.tooManyAttempts(wait);

    const tenant = await this.findTenant(input.tenant);
    if (!tenant || tenant.status !== 'active') {
      await this.passwords.verifyDecoy(input.password);
      throw INVALID_CREDENTIALS();
    }
    return unwrap(await this.db.withTenant(tenant.id, (trx) => this.attemptLogin(trx, tenant, input, meta)));
  }

  private async attemptLogin(
    trx: Trx,
    tenant: TenantRow,
    input: LoginInput,
    meta: RequestMeta,
  ): Promise<Outcome<LoginResult>> {
    const ip = normalizeIp(meta.ip);
    const attempt = (userId: string | null, result: Parameters<AuthRepository['recordAttempt']>[1]['result']) =>
      this.repo.recordAttempt(trx, {
        tenantId: tenant.id,
        userId,
        result,
        ip,
        lat: input.location?.lat,
        lng: input.location?.lng,
      });

    if ((await this.repo.countRecentAttemptsFromIp(trx, ip)) >= this.env.LOGIN_IP_MAX_ATTEMPTS) {
      return fail(this.tooManyAttempts(60));
    }

    const user = await this.repo.findLoginUser(trx, input.email);
    if (!user) {
      await this.passwords.verifyDecoy(input.password);
      await attempt(null, 'bad_password');
      return fail(INVALID_CREDENTIALS());
    }

    const passwordOk = await this.passwords.verify(user.password_hash, input.password);
    if (!passwordOk) {
      // A locked account is not counted again, and a guesser is not told it is locked.
      if (!user.locked) {
        await this.repo.registerFailure(trx, user.id, this.env.LOGIN_MAX_FAILURES, this.env.LOGIN_LOCK_MINUTES);
      }
      await attempt(user.id, 'bad_password');
      return fail(INVALID_CREDENTIALS());
    }
    if (user.locked) {
      await attempt(user.id, 'locked');
      return fail(
        new AppError('ACCOUNT_LOCKED', 'Too many wrong passwords. Please try again in a few minutes.', 423),
      );
    }
    if (user.status !== 'active') {
      await attempt(user.id, 'inactive');
      return fail(new AppError('ACCOUNT_INACTIVE', 'This account is not active. Please contact your administrator.', 403));
    }

    let deviceId: string | null = null;
    if (user.requires_office) {
      const office = await this.checkOffice(trx, user, input, ip);
      if (!office.ok) {
        await attempt(user.id, 'outside_office');
        // The Super Admin hears about it (once in ten minutes for the same person).
        await this.notifications.notifySuperAdmins(trx, {
          tenantId: tenant.id, quietMinutes: 10,
          payload: { event: 'login_refused', userId: user.id, userName: user.name, reason: office.error.details?.reason ?? 'outside_office', ip },
        });
        return fail(office.error);
      }
      if (input.clientType === 'mobile') {
        const device = await this.checkDevice(trx, tenant.id, user.id, input);
        if (!device.ok) {
          await attempt(user.id, 'device_blocked');
          return fail(device.error);
        }
        deviceId = device.value;
      }
    }

    const sessionId = await this.repo.newId(trx);
    const refresh = this.tokens.newRefreshToken({ tenantId: tenant.id, sessionId });
    await this.repo.createSession(trx, {
      id: sessionId,
      tenantId: tenant.id,
      userId: user.id,
      deviceId,
      refreshHash: refresh.hash,
      ip,
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
      clientType: input.clientType,
      maxHours: this.env.SESSION_MAX_HOURS,
    });
    await this.repo.registerSuccess(trx, user.id);
    await attempt(user.id, 'success');
    // Signing in from the office is the attendance: people who must sign in from the office are
    // checked in here, and checked out when their last session ends (see migration 013).
    if (user.requires_office) {
      await this.attendance.checkIn(trx, {
        tenantId: tenant.id,
        userId: user.id,
        branchId: user.branch_id,
        ip,
        lat: input.location?.lat,
        lng: input.location?.lng,
        accuracy: input.location?.accuracy,
      });
    }

    const access = await this.tokens.signAccess({ userId: user.id, tenantId: tenant.id, sessionId });
    return ok({
      accessToken: access.token,
      expiresIn: access.expiresInSec,
      refreshToken: refresh.token,
      clientType: input.clientType,
      mustChangePassword: user.must_change_password,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: { key: user.role_key, name: user.role_name },
      },
    });
  }

  private async checkOffice(trx: Trx, user: LoginUser, input: LoginInput, ip: string): Promise<Outcome<true>> {
    const refuse = (reason: OfficeFailure) => fail(new AppError('OUTSIDE_OFFICE', OFFICE_MESSAGES[reason], 403, undefined, undefined, { reason }));
    if (!user.branch_id) return refuse('not_configured');

    const facts = await this.repo.officeFacts(trx, user.branch_id, ip, input.wifiId);
    if (!facts.branch || !facts.branch.is_active) return refuse('not_configured');

    const result = evaluateOffice({
      branch: facts.branch,
      hasNetworks: facts.hasNetworks,
      networkMatches: facts.networkMatches,
      location: input.location,
      maxAccuracyM: this.env.GPS_MAX_ACCURACY_M,
    });
    return result.ok ? ok(true) : refuse(result.reason);
  }

  private async checkDevice(
    trx: Trx,
    tenantId: string,
    userId: string,
    input: LoginInput,
  ): Promise<Outcome<string>> {
    if (!input.device) {
      return fail(AppError.badRequest('DEVICE_REQUIRED', 'The app must identify this phone to sign in'));
    }
    const device = await this.repo.findOrCreateDevice(trx, {
      tenantId,
      userId,
      fingerprint: input.device.fingerprint,
      platform: input.device.platform,
      label: input.device.label,
    });
    if (!device.approved) {
      return fail(
        new AppError('DEVICE_NOT_APPROVED', 'This phone is waiting for approval from your Admin.', 403),
      );
    }
    return ok(device.id);
  }

  // ---------------------------------------------------------------- refresh

  async refresh(rawToken: string | undefined, meta: RequestMeta): Promise<SignedIn> {
    const parts = rawToken ? this.tokens.parseRefreshToken(rawToken) : null;
    if (!rawToken || !parts) throw this.signInAgain();

    return unwrap(
      await this.db.withTenant(parts.tenantId, async (trx): Promise<Outcome<SignedIn>> => {
        const session = await this.repo.lockSessionForRefresh(trx, parts.sessionId);
        if (!session) return fail(this.signInAgain());

        const presented = hashToken(rawToken);
        // An old token that is presented again means two parties hold the same token. End the
        // session, so neither the owner nor a thief can carry on with it.
        if (session.prev_refresh_token_hash && safeEqualHex(presented, session.prev_refresh_token_hash)) {
          if (!session.ended) {
            await this.repo.endSession(trx, session.id, 'reuse_detected');
            await this.audit.write(trx, {
              tenantId: parts.tenantId,
              actorId: session.user_id,
              action: 'auth.refresh_token_reuse',
              entity: 'session',
              entityId: session.id,
              ip: meta.ip,
              requestId: meta.requestId,
            });
          }
          return fail(this.signInAgain());
        }
        if (!safeEqualHex(presented, session.refresh_token_hash)) return fail(this.signInAgain());

        const stopped = await this.sessionProblem(trx, session);
        if (stopped) return fail(stopped);

        const next = this.tokens.newRefreshToken({ tenantId: parts.tenantId, sessionId: session.id });
        await this.repo.rotateRefreshToken(trx, session.id, session.refresh_token_hash, next.hash);
        const access = await this.tokens.signAccess({
          userId: session.user_id,
          tenantId: parts.tenantId,
          sessionId: session.id,
        });
        return ok({
          accessToken: access.token,
          expiresIn: access.expiresInSec,
          refreshToken: next.token,
          clientType: session.client_type === 'mobile' ? 'mobile' : 'web',
        });
      }),
    );
  }

  // ---------------------------------------------------- every authenticated request

  /** Checks the access token and the session behind it. Called by the AuthGuard on every request. */
  async authenticate(accessToken: string, meta: RequestMeta): Promise<AuthContext> {
    const claims = await this.tokens.verifyAccess(accessToken);
    return unwrap(
      await this.db.withTenant(claims.tenantId, async (trx): Promise<Outcome<AuthContext>> => {
        const row = await this.repo.findSession(trx, claims.sessionId, claims.userId);
        if (!row) return fail(new AppError('SESSION_INVALID', 'Please sign in again', 401));

        const stopped = await this.sessionProblem(trx, { ...row, id: row.session_id });
        if (stopped) return fail(stopped);

        await this.repo.touchSession(trx, row.session_id);
        return ok({
          userId: row.user_id,
          tenantId: claims.tenantId,
          sessionId: row.session_id,
          name: row.name,
          email: row.email,
          roleId: row.role_id,
          roleKey: row.role_key,
          dataScope: row.data_scope,
          permissions: new Set(row.permissions),
          mustChangePassword: row.must_change_password,
          tracksAttendance: row.requires_office,
          ip: normalizeIp(meta.ip),
          requestId: meta.requestId,
        });
      }),
    );
  }

  /**
   * Why a session may no longer be used, or null if it is fine. Ends the session when the reason
   * is that it ran out, so the state in the database matches what the person is told.
   */
  private async sessionProblem(
    trx: Trx,
    s: { id: string; ended: boolean; expired: boolean; idle_seconds: number; idle_limit_min: number; user_status: string; tenant_status: string },
  ): Promise<AppError | null> {
    if (s.ended) return new AppError('SESSION_ENDED', 'You have been signed out. Please sign in again.', 401);
    if (s.user_status !== 'active' || s.tenant_status !== 'active') {
      await this.repo.endSession(trx, s.id, 'revoked');
      return new AppError('ACCOUNT_INACTIVE', 'This account is not active. Please contact your administrator.', 401);
    }
    if (s.expired) {
      await this.repo.endSession(trx, s.id, 'expired');
      return new AppError('SESSION_EXPIRED', 'Your session has ended. Please sign in again.', 401);
    }
    if (s.idle_seconds > s.idle_limit_min * 60) {
      await this.repo.endSession(trx, s.id, 'inactivity');
      return new AppError(
        'SESSION_IDLE',
        `You were signed out after ${s.idle_limit_min} minutes of inactivity.`,
        401,
      );
    }
    return null;
  }

  // ---------------------------------------------------------- account actions

  async logout(auth: AuthContext): Promise<void> {
    await this.db.withTenant(auth.tenantId, async (trx) => {
      await this.repo.endSession(trx, auth.sessionId, 'logout');
    });
  }

  async changePassword(
    auth: AuthContext,
    input: { currentPassword: string; newPassword: string },
  ): Promise<{ otherSessionsEnded: number }> {
    const outcome = await this.db.withTenant(auth.tenantId, async (trx): Promise<Outcome<number>> => {
      const currentHash = await this.repo.findPasswordHash(trx, auth.userId);
      if (!currentHash) return fail(AppError.notFound('Account'));

      if (!(await this.passwords.verify(currentHash, input.currentPassword))) {
        // Someone holding a stolen session must not be able to guess the password here.
        await this.repo.registerFailure(trx, auth.userId, this.env.LOGIN_MAX_FAILURES, this.env.LOGIN_LOCK_MINUTES);
        return fail(new AppError('CURRENT_PASSWORD_WRONG', 'The current password is not correct', 403));
      }
      const problem = passwordProblem(input.newPassword, auth.email);
      if (problem) {
        return fail(AppError.badRequest('PASSWORD_REJECTED', problem, [{ field: 'newPassword', message: problem }]));
      }
      if (await this.passwords.verify(currentHash, input.newPassword)) {
        const message = 'Choose a password you have not used just now';
        return fail(AppError.badRequest('PASSWORD_REJECTED', message, [{ field: 'newPassword', message }]));
      }

      await this.repo.changePassword(trx, auth.userId, await this.passwords.hash(input.newPassword));
      const ended = await this.repo.endOtherSessions(trx, auth.userId, auth.sessionId, 'revoked');
      await this.audit.write(trx, {
        tenantId: auth.tenantId,
        actorId: auth.userId,
        action: 'auth.password_changed',
        entity: 'user',
        entityId: auth.userId,
        ip: auth.ip,
        requestId: auth.requestId,
      });
      return ok(ended);
    });
    return { otherSessionsEnded: unwrap(outcome) };
  }

  async profile(auth: AuthContext) {
    const company = await this.db.withTenant(auth.tenantId, (trx) => this.repo.companyProfile(trx));
    const settings = (company.settings ?? {}) as { product_name?: string; contact_email?: string; brand_color?: string; accent_color?: string; logo_key?: string };
    return {
      user: {
        id: auth.userId,
        name: auth.name,
        email: auth.email,
        role: { key: auth.roleKey, dataScope: auth.dataScope },
        mustChangePassword: auth.mustChangePassword,
      },
      permissions: [...auth.permissions].sort(),
      company: {
        name: company.name,
        productName: settings.product_name ?? `${company.name} CRM`,
        contactEmail: settings.contact_email ?? null,
        brandColor: settings.brand_color ?? null,
        accentColor: settings.accent_color ?? null,
        hasLogo: !!settings.logo_key,
      },
    };
  }

  async listSessions(auth: AuthContext) {
    const rows = await this.db.withTenant(auth.tenantId, (trx) => this.repo.listActiveSessions(trx, auth.userId));
    return rows.map((r) => ({
      id: r.id,
      current: r.id === auth.sessionId,
      clientType: r.client_type,
      ip: r.ip,
      userAgent: r.user_agent,
      signedInAt: r.created_at,
      lastActiveAt: r.last_active_at,
    }));
  }

  /**
   * Ends a session. People end their own; whoever manages users (the Super Admin) can end anyone's,
   * which is written to the audit log and reported to the other Super Admins.
   */
  async revokeSession(auth: AuthContext, sessionId: string): Promise<void> {
    await this.db.withTenant(auth.tenantId, async (trx) => {
      const own = await this.repo.listActiveSessions(trx, auth.userId);
      const isOwn = own.some((s) => s.id === sessionId);
      let target: { userId: string; userName: string } | null = null;
      if (!isOwn) {
        if (!auth.permissions.has('user.manage')) throw AppError.notFound('Session');
        const { rows } = await sql<{ user_id: string; name: string }>`
          SELECT s.user_id, u.name FROM user_sessions s JOIN users u ON u.id = s.user_id
          WHERE s.id = ${sessionId}::uuid AND s.ended_at IS NULL AND s.expires_at > now()`.execute(trx);
        if (!rows[0]) throw AppError.notFound('Session');
        target = { userId: rows[0].user_id, userName: rows[0].name };
      }
      await this.repo.endSession(trx, sessionId, 'revoked');
      await this.audit.write(trx, {
        tenantId: auth.tenantId,
        actorId: auth.userId,
        action: isOwn ? 'auth.session_revoked' : 'auth.session_revoked_by_admin',
        entity: 'session',
        entityId: sessionId,
        after: target ? { userId: target.userId } : undefined,
        ip: auth.ip,
        requestId: auth.requestId,
      });
      if (target) {
        await this.notifications.notifySuperAdmins(trx, {
          tenantId: auth.tenantId, exceptUserId: auth.userId,
          payload: { event: 'forced_logout', userId: target.userId, userName: target.userName, byUserId: auth.userId },
        });
      }
    });
  }

  /** Every active session in the company, for those who manage users. */
  async listTenantSessions(auth: AuthContext, userId?: string) {
    const { rows } = await this.db.withTenant(auth.tenantId, (trx) =>
      sql<{ id: string; user_id: string; user_name: string; role_name: string; client_type: string; ip: string | null; user_agent: string | null; created_at: Date; last_active_at: Date }>`
        SELECT s.id, s.user_id, u.name AS user_name, r.name AS role_name, s.client_type, s.ip::text AS ip, s.user_agent, s.created_at, s.last_active_at
        FROM user_sessions s JOIN users u ON u.id = s.user_id JOIN roles r ON r.id = u.role_id
        WHERE s.ended_at IS NULL AND s.expires_at > now() ${userId ? sql`AND s.user_id = ${userId}::uuid` : sql``}
        ORDER BY s.last_active_at DESC LIMIT 300`.execute(trx),
    );
    return rows.map((r) => ({ id: r.id, current: r.id === auth.sessionId, user: { id: r.user_id, name: r.user_name, role: r.role_name }, clientType: r.client_type, ip: r.ip, userAgent: r.user_agent, signedInAt: r.created_at, lastActiveAt: r.last_active_at }));
  }

  // ---------------------------------------------------------------- helpers

  private async findTenant(slug: string): Promise<TenantRow | undefined> {
    const { rows } = await sql<TenantRow>`SELECT id, name, status FROM find_tenant_by_slug(${slug})`.execute(
      this.db.unscoped(),
    );
    return rows[0];
  }

  private signInAgain(): AppError {
    return new AppError('TOKEN_INVALID', 'Your sign-in is not valid. Please sign in again.', 401);
  }

  private tooManyAttempts(retryAfterSec: number): AppError {
    return new AppError(
      'TOO_MANY_ATTEMPTS',
      'Too many sign-in attempts. Please wait a few minutes and try again.',
      429,
      undefined,
      { 'retry-after': String(retryAfterSec) },
    );
  }
}
