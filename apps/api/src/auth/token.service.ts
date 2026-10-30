import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { jwtVerify, SignJWT } from 'jose';
import { AppError } from '../common/app-error.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';

const ISSUER = 'admissions-house-crm';
const AUDIENCE = 'admissions-house-crm-api';

export interface AccessClaims {
  userId: string;
  tenantId: string;
  sessionId: string;
}

export interface RefreshTokenParts {
  tenantId: string;
  sessionId: string;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const REFRESH_FORMAT = new RegExp(`^v1\\.(${UUID})\\.(${UUID})\\.([A-Za-z0-9_-]{43})$`, 'i');

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

@Injectable()
export class TokenService {
  private readonly key: Uint8Array;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.key = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
  }

  /**
   * A short-lived access token. It names the user, company and session and nothing else. What the
   * person may do is looked up on every request, so a changed role or an ended session takes
   * effect at once instead of when the token expires.
   */
  async signAccess(claims: AccessClaims): Promise<{ token: string; expiresInSec: number }> {
    const token = await new SignJWT({ tid: claims.tenantId, sid: claims.sessionId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${this.env.ACCESS_TOKEN_TTL_SEC}s`)
      .sign(this.key);
    return { token, expiresInSec: this.env.ACCESS_TOKEN_TTL_SEC };
  }

  async verifyAccess(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ['HS256'],
        clockTolerance: 5,
      });
      const { sub, tid, sid } = payload as { sub?: string; tid?: unknown; sid?: unknown };
      if (!sub || typeof tid !== 'string' || typeof sid !== 'string') throw new Error('claims missing');
      return { userId: sub, tenantId: tid, sessionId: sid };
    } catch {
      throw new AppError('TOKEN_INVALID', 'Your sign-in is not valid. Please sign in again.', 401);
    }
  }

  /**
   * A refresh token carries the company and session so that it can be looked up under row-level
   * security, plus 256 random bits. Only a hash of the whole token is stored.
   */
  newRefreshToken(parts: RefreshTokenParts): { token: string; hash: string } {
    const token = `v1.${parts.tenantId}.${parts.sessionId}.${randomBytes(32).toString('base64url')}`;
    return { token, hash: hashToken(token) };
  }

  parseRefreshToken(token: string): RefreshTokenParts | null {
    const match = REFRESH_FORMAT.exec(token);
    return match ? { tenantId: match[1]!.toLowerCase(), sessionId: match[2]!.toLowerCase() } : null;
  }
}
