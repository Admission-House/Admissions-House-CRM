import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';

const VERSION = 'v1';

/**
 * Encrypts small secrets before they are stored (provider credentials, and later bank details), with
 * AES-256-GCM. Each value gets its own random IV, and GCM detects any change to the stored text.
 * The text looks like v1.<iv>.<tag>.<ciphertext>; the version lets the scheme change later.
 * `context` names what the value belongs to and is part of what GCM authenticates, so a value copied
 * to another row or column does not decrypt there.
 */
@Injectable()
export class SecretBox {
  private readonly key: Buffer;

  constructor(@Inject(ENV) env: Pick<Env, 'DATA_ENCRYPTION_KEY'>) {
    this.key = Buffer.from(env.DATA_ENCRYPTION_KEY, 'hex');
  }

  seal(plain: string, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
  }

  /** Throws if the text was altered, belongs to another context, or was sealed with another key. */
  open(sealed: string, context: string): string {
    const [version, iv, tag, data, ...extra] = sealed.split('.');
    if (version !== VERSION || !iv || !tag || data === undefined || extra.length > 0) throw new Error('not a sealed value');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  }
}
