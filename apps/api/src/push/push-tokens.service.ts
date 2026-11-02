import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { AuthContext } from '../auth/auth-context.js';
import { AppError } from '../common/app-error.js';
import { DatabaseService } from '../database/database.service.js';
import { PushProvider } from './push-provider.js';

/** Most phones one person can have receiving alerts at once. The oldest ones are dropped beyond this. */
const MAX_PHONES_PER_PERSON = 10;

@Injectable()
export class PushTokensService {
  constructor(
    private readonly db: DatabaseService,
    private readonly provider: PushProvider,
  ) {}

  /**
   * Records that this phone, in this sign-in, takes alerts for this person. A phone that is handed to
   * someone else moves to the new person. Safe to call on every app start.
   */
  register(auth: AuthContext, input: { token: string; platform: 'android' | 'ios' }): Promise<{ registered: true }> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      await sql`
        INSERT INTO push_tokens (tenant_id, user_id, session_id, token, platform)
        VALUES (${auth.tenantId}, ${auth.userId}, ${auth.sessionId}, ${input.token}, ${input.platform})
        ON CONFLICT (tenant_id, token) DO UPDATE
          SET user_id = EXCLUDED.user_id, session_id = EXCLUDED.session_id, platform = EXCLUDED.platform, last_seen_at = now()`.execute(trx);
      // Tidy: phones whose sign-in has ended can never receive again, and the oldest beyond the limit go.
      await sql`
        DELETE FROM push_tokens t USING user_sessions s
        WHERE t.user_id = ${auth.userId} AND s.id = t.session_id AND s.ended_at IS NOT NULL`.execute(trx);
      await sql`
        DELETE FROM push_tokens WHERE id IN (
          SELECT id FROM push_tokens WHERE user_id = ${auth.userId} ORDER BY last_seen_at DESC OFFSET ${MAX_PHONES_PER_PERSON})`.execute(trx);
      return { registered: true } as const;
    });
  }

  /** Stops alerts to this phone for the signed-in person (called when they sign out). */
  unregister(auth: AuthContext, token: string): Promise<{ removed: number }> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const res = await sql`DELETE FROM push_tokens WHERE user_id = ${auth.userId} AND token = ${token}`.execute(trx);
      return { removed: Number(res.numAffectedRows ?? 0) };
    });
  }

  /** Sends a test alert to the person's own phones, so they can see that alerts work. */
  async sendTest(auth: AuthContext): Promise<{ phones: number }> {
    const tokens = await this.db.withTenant(auth.tenantId, async (trx) => {
      const { rows } = await sql<{ token: string }>`
        SELECT t.token FROM push_tokens t JOIN user_sessions s ON s.id = t.session_id
        WHERE t.user_id = ${auth.userId} AND s.ended_at IS NULL AND s.expires_at > now()`.execute(trx);
      return rows.map((r) => r.token);
    });
    if (tokens.length === 0) {
      throw new AppError('NO_PUSH_PHONE', 'This phone is not set up for alerts yet. Allow notifications for the app and try again.', 409);
    }
    const results = await this.provider.send(tokens.map((to) => ({ to, title: 'Alerts are working', body: 'You will get alerts like this one on this phone.', data: {} })));
    const refused = results.flatMap((r) => (r.status === 'error' ? [r.message] : []));
    if (refused.length === results.length) {
      throw new AppError('PUSH_FAILED', `The alert could not be sent: ${refused[0] ?? 'unknown reason'}`, 502);
    }
    return { phones: results.length - refused.length };
  }
}
