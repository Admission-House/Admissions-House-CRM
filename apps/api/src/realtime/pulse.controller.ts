import { Controller, Get, Inject } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { sql } from 'kysely';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';

export interface Pulse {
  /** When each topic last changed for this person. A topic that never changed is missing. */
  stamps: Record<string, string>;
  /** Someone is calling this person right now: the screen should look again soon. */
  ringing: boolean;
}

/**
 * The same hints a WebSocket would carry, asked for instead of pushed: for a place that cannot keep a
 * connection open. One small question for every topic, so a screen does not poll each thing on its own.
 * The browser compares the times with the last ones it saw, and reloads only the screens that changed.
 */
@ApiTags('realtime')
@ApiBearerAuth()
@Controller('realtime')
export class PulseController {
  constructor(
    private readonly db: DatabaseService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('pulse')
  pulse(@CurrentAuth() auth: AuthContext): Promise<Pulse> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const { rows } = await sql<{ topic: string; at: Date }>`
        SELECT topic, max(bumped_at) AS at FROM live_stamps
        WHERE scope IN (${auth.userId}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
        GROUP BY topic`.execute(trx);
      const ring = await sql<{ one: number }>`
        SELECT 1 AS one FROM video_session_invites i JOIN video_sessions s ON s.id = i.session_id
        WHERE i.user_id = ${auth.userId}::uuid AND i.state = 'ringing' AND s.status = 'open'
          AND i.invited_at > now() - make_interval(secs => ${this.env.COMMUNICATION_RING_SECONDS}) LIMIT 1`.execute(trx);
      return { stamps: Object.fromEntries(rows.map((r) => [r.topic, new Date(r.at).toISOString()])), ringing: ring.rows.length > 0 };
    });
  }
}
