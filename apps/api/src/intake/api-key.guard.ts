import { createHash } from 'node:crypto';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../common/app-error.js';
import { SlidingWindowLimiter } from '../common/rate-limiter.js';
import { DatabaseService } from '../database/database.service.js';

/** Who is calling the intake API: a company's lead source, identified by its key. */
export interface IntakeContext {
  tenantId: string;
  sourceId: string;
  apiKeyId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    intake?: IntakeContext;
  }
}

const KEY_FORMAT = /^ahk_[A-Za-z0-9_-]{20,80}$/;

export const hashApiKey = (key: string): string => createHash('sha256').update(key).digest('hex');

/**
 * Lets a lead source in with its API key, sent as "Authorization: Bearer ahk_..." (the website's
 * connector does this) or as "X-API-Key". Only a hash of the key is stored, so a leaked database
 * does not leak keys. A key can be revoked at any time.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  /** Calls a key may make per minute. Generous for a form, tight enough to stop a runaway sender. */
  private readonly perKey = new SlidingWindowLimiter(300, 60_000);
  /** Wrong keys from one address. A real key cannot be guessed; this just keeps the noise down. */
  private readonly badKeysPerAddress = new SlidingWindowLimiter(20, 60_000);

  constructor(private readonly db: DatabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const key = this.extractKey(request);

    const ctx = key ? await this.lookup(key) : undefined;
    if (!ctx) {
      const wait = this.badKeysPerAddress.hit(request.ip);
      if (wait) throw tooMany(wait);
      throw new AppError('INVALID_API_KEY', 'The API key is missing or not valid', 401);
    }

    const wait = this.perKey.hit(ctx.apiKeyId);
    if (wait) throw tooMany(wait);
    request.intake = ctx;
    return true;
  }

  private extractKey(request: FastifyRequest): string | undefined {
    const bearer = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1];
    const header = request.headers['x-api-key'];
    const key = bearer ?? (typeof header === 'string' ? header : undefined);
    return key && KEY_FORMAT.test(key) ? key : undefined;
  }

  private async lookup(key: string): Promise<IntakeContext | undefined> {
    const { rows } = await sql<{ api_key_id: string; tenant_id: string; source_id: string }>`
      SELECT * FROM resolve_api_key(${hashApiKey(key)})`.execute(this.db.unscoped());
    const row = rows[0];
    return row && { apiKeyId: row.api_key_id, tenantId: row.tenant_id, sourceId: row.source_id };
  }
}

const tooMany = (seconds: number) =>
  new AppError('RATE_LIMITED', 'Too many requests. Please slow down.', 429, undefined, { 'retry-after': String(seconds) });
