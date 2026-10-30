import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';

export interface FileClaims {
  /** Storage key of the file. */
  key: string;
  /** Content type, as detected when it was uploaded. */
  type: string;
  /** The name to offer when it is saved. */
  name: string;
}

/**
 * A short-lived link to one file, so a browser can show an image or open a PDF without sending a
 * login header. The link is signed, names the file, and stops working at its expiry. It reveals
 * nothing and cannot be edited: changing a character breaks the signature.
 */
@Injectable()
export class FileLinks {
  private readonly secret: string;

  constructor(@Inject(ENV) private readonly env: Env) {
    // A key of its own, so a file link can never be mistaken for a login token.
    this.secret = `file-links:${env.JWT_ACCESS_SECRET}`;
  }

  sign(claims: FileClaims, ttlSec = this.env.FILE_LINK_TTL_SEC): { token: string; expiresAt: Date } {
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    const body = Buffer.from(JSON.stringify({ k: claims.key, t: claims.type, n: claims.name, e: exp })).toString('base64url');
    return { token: `${body}.${this.mac(body)}`, expiresAt: new Date(exp * 1000) };
  }

  /** The claims, or the reason the link cannot be used. */
  verify(token: string): { ok: true; claims: FileClaims } | { ok: false; reason: 'invalid' | 'expired' } {
    const [body, mac, ...extra] = token.split('.');
    if (!body || !mac || extra.length > 0) return { ok: false, reason: 'invalid' };

    const expected = Buffer.from(this.mac(body), 'base64url');
    const given = Buffer.from(mac, 'base64url');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'invalid' };

    try {
      const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { k?: unknown; t?: unknown; n?: unknown; e?: unknown };
      if (typeof parsed.k !== 'string' || typeof parsed.t !== 'string' || typeof parsed.n !== 'string' || typeof parsed.e !== 'number') {
        return { ok: false, reason: 'invalid' };
      }
      if (parsed.e < Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired' };
      return { ok: true, claims: { key: parsed.k, type: parsed.t, name: parsed.n } };
    } catch {
      return { ok: false, reason: 'invalid' };
    }
  }

  private mac(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url');
  }
}
