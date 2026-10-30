import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import { AppError } from '../common/app-error.js';
import { SlidingWindowLimiter } from '../common/rate-limiter.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { MailerService } from '../mail/mailer.service.js';
import { AuthRepository } from './auth.repository.js';
import { passwordProblem, PasswordService } from './password.service.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const TOKEN = /^v1\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;
const INVALID = () => new AppError('RESET_LINK_INVALID', 'This reset link is not valid or has expired. Ask for a new one.', 400);
/** A second request this soon after the first sends nothing more, so the form cannot be used to flood someone's inbox. */
const RESEND_AFTER_SEC = 120;

/**
 * "Forgot my password". The reply to a request is always the same, whether or not the address
 * belongs to anyone, so it cannot be used to find out who has an account. The link carries a random
 * secret (only its hash is kept), works once and expires. Using it ends every session of the person
 * and lifts any lock on the account.
 */
@Injectable()
export class PasswordResetService {
  private readonly perAddress = new SlidingWindowLimiter(5, 15 * 60_000);
  private readonly badLinks = new SlidingWindowLimiter(10, 15 * 60_000);

  constructor(
    private readonly db: DatabaseService,
    private readonly repo: AuthRepository,
    private readonly passwords: PasswordService,
    private readonly mailer: MailerService,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async request(input: { tenant: string; email: string }, ip: string): Promise<void> {
    const wait = this.perAddress.hit(ip);
    if (wait) throw new AppError('RATE_LIMITED', 'Too many requests. Try again later.', 429, undefined, { 'retry-after': String(wait) });

    const { rows: tenants } = await sql<{ id: string; name: string; status: string }>`SELECT id, name, status FROM find_tenant_by_slug(${input.tenant})`.execute(this.db.unscoped());
    const tenant = tenants[0];
    if (!tenant || tenant.status !== 'active') return;

    const mail = await this.db.withTenant(tenant.id, async (trx) => {
      const { rows } = await sql<{ id: string; name: string; email: string }>`SELECT id, name, email::text AS email FROM users WHERE email = ${input.email} AND status = 'active'`.execute(trx);
      const user = rows[0];
      if (!user) return null;
      const { rows: recent } = await sql<{ id: string }>`
        SELECT id FROM password_reset_tokens WHERE user_id = ${user.id}::uuid AND created_at > now() - make_interval(secs => ${RESEND_AFTER_SEC}) LIMIT 1`.execute(trx);
      if (recent[0]) return null;

      const secret = randomBytes(32).toString('base64url');
      await sql`
        INSERT INTO password_reset_tokens (tenant_id, user_id, token_hash, expires_at, requested_ip)
        VALUES (${tenant.id}, ${user.id}, ${sha256(secret)}, now() + make_interval(mins => ${this.env.RESET_LINK_TTL_MIN}), ${ip}::inet)`.execute(trx);
      await this.audit.write(trx, { tenantId: tenant.id, actorId: user.id, action: 'auth.password_reset_requested', entity: 'user', entityId: user.id, ip });
      const link = `${this.env.WEB_URL.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(`v1.${tenant.id}.${secret}`)}`;
      return {
        to: user.email,
        subject: `Reset your ${tenant.name} CRM password`,
        text: `Hello ${user.name},\n\nSomeone asked to reset the password for your ${tenant.name} CRM account. Open this link to choose a new one:\n\n${link}\n\nThe link works once and expires in ${this.env.RESET_LINK_TTL_MIN} minutes. If you did not ask for this, ignore this email; your password has not changed.\n`,
      };
    });
    // Sent after the answer is decided, so the reply does not take longer when an account exists.
    if (mail) setImmediate(() => void this.mailer.send(mail));
  }

  async reset(input: { token: string; newPassword: string }, ip: string): Promise<void> {
    const wait = this.badLinks.hit(ip);
    if (wait) throw new AppError('RATE_LIMITED', 'Too many attempts. Try again later.', 429, undefined, { 'retry-after': String(wait) });
    const m = TOKEN.exec(input.token);
    if (!m) throw INVALID();
    const [, tenantId, secret] = m as unknown as [string, string, string];

    const failure = await this.db.withTenant(tenantId, async (trx): Promise<AppError | null> => {
      const { rows } = await sql<{ id: string; user_id: string; email: string }>`
        SELECT t.id, t.user_id, u.email::text AS email FROM password_reset_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = ${sha256(secret)} AND t.used_at IS NULL AND t.expires_at > now() AND u.status = 'active' FOR UPDATE OF t`.execute(trx);
      const row = rows[0];
      if (!row) return INVALID();
      const problem = passwordProblem(input.newPassword, row.email);
      if (problem) return AppError.badRequest('PASSWORD_REJECTED', problem, [{ field: 'newPassword', message: problem }]);

      await this.repo.changePassword(trx, row.user_id, await this.passwords.hash(input.newPassword));
      await sql`UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ${row.user_id}::uuid`.execute(trx);
      await sql`UPDATE password_reset_tokens SET used_at = now() WHERE user_id = ${row.user_id}::uuid AND used_at IS NULL`.execute(trx);
      await this.repo.endAllSessions(trx, row.user_id, 'revoked');
      await this.audit.write(trx, { tenantId, actorId: row.user_id, action: 'auth.password_reset', entity: 'user', entityId: row.user_id, ip });
      return null;
    }).catch((err: unknown) => {
      // A tenant id that does not exist, or is malformed, is just another bad link.
      if (err instanceof AppError) throw err;
      return INVALID();
    });
    if (failure) throw failure;
  }
}
