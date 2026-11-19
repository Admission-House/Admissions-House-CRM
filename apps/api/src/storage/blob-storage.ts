import { del, get, put } from '@vercel/blob';
import { Readable } from 'node:stream';
import type { ReadableStream as WebStream } from 'node:stream/web';
import { KEY, StorageService } from './storage.service.js';

/** The minimum of the Blob client this class uses, so a test can stand in for it. */
export interface BlobLike {
  put(key: string, data: Buffer, options: { access: 'private'; addRandomSuffix: false; allowOverwrite: false; contentType: string; token?: string }): Promise<unknown>;
  get(key: string, options: { access: 'private'; token?: string }): Promise<{ statusCode: number; stream: unknown; blob: { size: number | null } } | null>;
  del(key: string, options: { token?: string }): Promise<void>;
}

const TYPES: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4' };

/**
 * Files in a private Vercel Blob store, for a server that has no disk of its own to keep files on (Vercel). The store
 * is private: a file is only ever handed out through the CRM (login or a short-lived signed link), never by a public address.
 */
export class BlobStorage extends StorageService {
  constructor(
    private readonly client: BlobLike = { put: put as never, get: get as never, del: del as never },
    private readonly token?: string,
  ) {
    super();
  }

  private check(key: string): string {
    if (!KEY.test(key)) throw new Error('not a valid storage key');
    return key;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const ext = this.check(key).split('.').pop()!;
    // A key is never written twice: the same file name is refused instead of overwriting someone's document.
    await this.client.put(key, data, { access: 'private', addRandomSuffix: false, allowOverwrite: false, contentType: TYPES[ext] ?? 'application/octet-stream', ...(this.token && { token: this.token }) });
  }

  async get(key: string): Promise<{ stream: Readable; size: number } | null> {
    const res = await this.client.get(this.check(key), { access: 'private', ...(this.token && { token: this.token }) });
    if (!res || res.statusCode !== 200 || !res.stream) return null;
    return { stream: Readable.fromWeb(res.stream as WebStream), size: res.blob.size ?? 0 };
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.del(this.check(key), { ...(this.token && { token: this.token }) });
    } catch (err) {
      if ((err as { name?: string }).name !== 'BlobNotFoundError') throw err;
    }
  }
}
