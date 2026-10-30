import { createHash } from 'node:crypto';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { AppError } from '../common/app-error.js';
import { SlidingWindowLimiter } from '../common/rate-limiter.js';
import { DatabaseService } from '../database/database.service.js';

export interface TelephonyContext {
  tenantId: string;
  provider: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    telephony?: TelephonyContext;
  }
}

const KEY_FORMAT = /^ahw_[A-Za-z0-9_-]{20,80}$/;

export const hashWebhookKey = (key: string): string => createHash('sha256').update(key).digest('hex');

/**
 * Lets a telephony provider in with the company's webhook key, sent as "Authorization: Bearer ahw_..."
 * or "X-Webhook-Key". Only a hash is stored. The key goes in a header, never in the URL, because URLs
 * end up in logs.
 */
@Injectable()
export class TelephonyKeyGuard implements CanActivate {
  private readonly perCompany = new SlidingWindowLimiter(1200, 60_000);
  private readonly badKeysPerAddress = new SlidingWindowLimiter(20, 60_000);

  constructor(private readonly db: DatabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const bearer = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1];
    const header = request.headers['x-webhook-key'];
    const key = bearer ?? (typeof header === 'string' ? header : undefined);

    const found =
      key && KEY_FORMAT.test(key)
        ? (await sql<{ tenant_id: string; provider: string }>`SELECT * FROM resolve_telephony_key(${hashWebhookKey(key)})`.execute(this.db.unscoped())).rows[0]
        : undefined;
    if (!found) {
      const wait = this.badKeysPerAddress.hit(request.ip);
      if (wait) throw tooMany(wait);
      throw new AppError('INVALID_WEBHOOK_KEY', 'The webhook key is missing or not valid', 401);
    }
    const wait = this.perCompany.hit(found.tenant_id);
    if (wait) throw tooMany(wait);
    request.telephony = { tenantId: found.tenant_id, provider: found.provider };
    return true;
  }
}

const tooMany = (seconds: number) =>
  new AppError('RATE_LIMITED', 'Too many requests. Please slow down.', 429, undefined, { 'retry-after': String(seconds) });
