import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import { AppError } from '../common/app-error.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { SecretBox } from '../crypto/secret-box.js';
import { DatabaseService, Trx } from '../database/database.service.js';
import type { AuthContext } from './auth-context.js';
import { AuthRepository } from './auth.repository.js';
import { PasswordService } from './password.service.js';
import { hashRecoveryCode, looksLikeRecoveryCode, newRecoveryCode, newSecret, otpauthUrl, verifyTotp } from './totp.js';

const RECOVERY_CODES = 8;
const sealContext = (userId: string) => `mfa:${userId}`;

export type CodeCheck = 'ok' | 'recovery' | 'bad';

/**
 * Two-step sign-in: setting it up, turning it off, and checking a code at sign-in.
 *
 * A wrong password or code is counted as a failed attempt. The count must be saved, and throwing
 * inside a transaction would undo it, so those paths return the error and it is thrown after the
 * transaction has been committed.
 */
@Injectable()
export class MfaService {
  constructor(
    private readonly db: DatabaseService,
    private readonly box: SecretBox,
    private readonly passwords: PasswordService,
    private readonly repo: AuthRepository,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Whether this person has finished setting up two-step sign-in. */
  async isEnabled(trx: Trx, userId: string): Promise<boolean> {
    const { rows } = await sql<{ one: number }>`SELECT 1 AS one FROM user_mfa WHERE user_id = ${userId} AND enabled_at IS NOT NULL`.execute(trx);
    return rows.length > 0;
  }

  /**
   * Checks the code typed at sign-in: a 6-digit app code, or a recovery code (which then stops working).
   * The row is locked while it is checked, so two sign-ins at once cannot both use the same code.
   */
  async verifyLoginCode(trx: Trx, userId: string, typed: string, nowMs = Date.now()): Promise<CodeCheck> {
    const { rows } = await sql<{ secret_sealed: string; last_step: string | null }>`
      SELECT secret_sealed, last_step::text AS last_step FROM user_mfa WHERE user_id = ${userId} AND enabled_at IS NOT NULL FOR UPDATE`.execute(trx);
    const row = rows[0];
    if (!row) return 'bad';

    if (looksLikeRecoveryCode(typed)) {
      const res = await sql`
        UPDATE user_recovery_codes SET used_at = now()
        WHERE user_id = ${userId} AND code_hash = ${hashRecoveryCode(typed)} AND used_at IS NULL`.execute(trx);
      return Number(res.numAffectedRows ?? 0) === 1 ? 'recovery' : 'bad';
    }

    const step = verifyTotp(this.box.open(row.secret_sealed, sealContext(userId)), typed, nowMs, row.last_step === null ? null : Number(row.last_step));
    if (step === null) return 'bad';
    await sql`UPDATE user_mfa SET last_step = ${step} WHERE user_id = ${userId}`.execute(trx);
    return 'ok';
  }

  // ---------------------------------------------------------------- the person's own settings

  status(auth: AuthContext): Promise<{ enabled: boolean; setupStarted: boolean; recoveryCodesLeft: number }> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const { rows } = await sql<{ enabled: boolean }>`SELECT enabled_at IS NOT NULL AS enabled FROM user_mfa WHERE user_id = ${auth.userId}`.execute(trx);
      const { rows: left } = await sql<{ n: string }>`SELECT count(*) AS n FROM user_recovery_codes WHERE user_id = ${auth.userId} AND used_at IS NULL`.execute(trx);
      return { enabled: rows[0]?.enabled === true, setupStarted: rows.length > 0 && !rows[0]!.enabled, recoveryCodesLeft: Number(left[0]!.n) };
    });
  }

  /** Step 1: a new secret, shown as a QR code. It does nothing until step 2 proves the app can read it. */
  beginSetup(auth: AuthContext, password: string): Promise<{ secret: string; otpauthUrl: string }> {
    return this.settled(auth, async (trx) => {
      const wrong = await this.checkPassword(trx, auth, password);
      if (wrong) return wrong;
      if (await this.isEnabled(trx, auth.userId)) {
        return new AppError('MFA_ALREADY_ON', 'Two-step sign-in is already on. Turn it off first to set it up again.', 409);
      }
      const secret = newSecret();
      await sql`
        INSERT INTO user_mfa (tenant_id, user_id, secret_sealed) VALUES (${auth.tenantId}, ${auth.userId}, ${this.box.seal(secret, sealContext(auth.userId))})
        ON CONFLICT (user_id) DO UPDATE SET secret_sealed = EXCLUDED.secret_sealed, enabled_at = NULL, last_step = NULL, created_at = now()`.execute(trx);
      const company = await this.repo.companyProfile(trx);
      const issuer = (company.settings as { product_name?: string } | null)?.product_name || company.name;
      return { secret, otpauthUrl: otpauthUrl({ issuer, account: auth.email, secret }) };
    });
  }

  /** Step 2: the first code from the app turns it on, and returns the recovery codes. They are shown only now. */
  enable(auth: AuthContext, code: string): Promise<{ recoveryCodes: string[] }> {
    return this.settled(auth, async (trx) => {
      const { rows } = await sql<{ secret_sealed: string; enabled: boolean }>`
        SELECT secret_sealed, enabled_at IS NOT NULL AS enabled FROM user_mfa WHERE user_id = ${auth.userId} FOR UPDATE`.execute(trx);
      const row = rows[0];
      if (!row) return new AppError('MFA_NOT_STARTED', 'Start the set-up first.', 409);
      if (row.enabled) return new AppError('MFA_ALREADY_ON', 'Two-step sign-in is already on.', 409);

      const step = verifyTotp(this.box.open(row.secret_sealed, sealContext(auth.userId)), code, Date.now(), null);
      if (step === null) return new AppError('MFA_CODE_WRONG', 'The code is not correct. Check the newest code in your app and try again.', 400);

      await sql`UPDATE user_mfa SET enabled_at = now(), last_step = ${step} WHERE user_id = ${auth.userId}`.execute(trx);
      const recoveryCodes = Array.from({ length: RECOVERY_CODES }, newRecoveryCode);
      await sql`DELETE FROM user_recovery_codes WHERE user_id = ${auth.userId}`.execute(trx);
      for (const c of recoveryCodes) {
        await sql`INSERT INTO user_recovery_codes (tenant_id, user_id, code_hash) VALUES (${auth.tenantId}, ${auth.userId}, ${hashRecoveryCode(c)})`.execute(trx);
      }
      await this.audit.write(trx, { tenantId: auth.tenantId, actorId: auth.userId, action: 'auth.mfa_enabled', entity: 'user', entityId: auth.userId, ip: auth.ip, requestId: auth.requestId });
      return { recoveryCodes };
    });
  }

  /** Turning it off needs the password and a current code (or a recovery code), so a stolen session cannot do it. */
  disable(auth: AuthContext, input: { password: string; code: string }): Promise<{ enabled: false }> {
    return this.settled(auth, async (trx) => {
      const wrong = await this.checkPassword(trx, auth, input.password);
      if (wrong) return wrong;
      if (!(await this.isEnabled(trx, auth.userId))) return new AppError('MFA_NOT_ON', 'Two-step sign-in is not on.', 409);
      if ((await this.verifyLoginCode(trx, auth.userId, input.code)) === 'bad') {
        await this.repo.registerFailure(trx, auth.userId, this.env.LOGIN_MAX_FAILURES, this.env.LOGIN_LOCK_MINUTES);
        return new AppError('MFA_CODE_WRONG', 'The code is not correct.', 403);
      }
      await this.remove(trx, auth.userId);
      await this.audit.write(trx, { tenantId: auth.tenantId, actorId: auth.userId, action: 'auth.mfa_disabled', entity: 'user', entityId: auth.userId, ip: auth.ip, requestId: auth.requestId });
      return { enabled: false } as const;
    });
  }

  // ---------------------------------------------------------------- an administrator

  /** For someone who lost their phone: removes their two-step sign-in so they can sign in and set it up again. */
  resetFor(auth: AuthContext, userId: string): Promise<{ reset: boolean }> {
    return this.settled(auth, async (trx) => {
      const { rows } = await sql<{ one: number }>`SELECT 1 AS one FROM users WHERE id = ${userId}`.execute(trx);
      if (rows.length === 0) return AppError.notFound('User');
      const had = (await sql<{ one: number }>`SELECT 1 AS one FROM user_mfa WHERE user_id = ${userId}`.execute(trx)).rows.length > 0;
      await this.remove(trx, userId);
      if (had) await this.audit.write(trx, { tenantId: auth.tenantId, actorId: auth.userId, action: 'auth.mfa_reset', entity: 'user', entityId: userId, ip: auth.ip, requestId: auth.requestId });
      return { reset: had };
    });
  }

  // ---------------------------------------------------------------- helpers

  /** Runs the work in a transaction that is committed even when it ends in an error, then throws that error. */
  private async settled<T>(auth: AuthContext, work: (trx: Trx) => Promise<T | AppError>): Promise<T> {
    const out = await this.db.withTenant(auth.tenantId, work);
    if (out instanceof AppError) throw out;
    return out;
  }

  private async remove(trx: Trx, userId: string): Promise<void> {
    await sql`DELETE FROM user_recovery_codes WHERE user_id = ${userId}`.execute(trx);
    await sql`DELETE FROM user_mfa WHERE user_id = ${userId}`.execute(trx);
  }

  /** Null when the password is right; otherwise the failure is counted and the error to give back is returned. */
  private async checkPassword(trx: Trx, auth: AuthContext, password: string): Promise<AppError | null> {
    const hash = await this.repo.findPasswordHash(trx, auth.userId);
    if (hash && (await this.passwords.verify(hash, password))) return null;
    // Someone holding a stolen session must not be able to guess the password here.
    await this.repo.registerFailure(trx, auth.userId, this.env.LOGIN_MAX_FAILURES, this.env.LOGIN_LOCK_MINUTES);
    return new AppError('CURRENT_PASSWORD_WRONG', 'The password is not correct', 403);
  }
}
