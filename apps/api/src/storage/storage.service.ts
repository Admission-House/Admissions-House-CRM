import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';

/**
 * Where uploaded files live. Callers only ever hand over a key and bytes; the key is built by the
 * server, never from anything a user typed. A cloud store is another class behind this same shape.
 */
export abstract class StorageService {
  abstract put(key: string, data: Buffer): Promise<void>;
  abstract get(key: string): Promise<{ stream: Readable; size: number } | null>;
  abstract delete(key: string): Promise<void>;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** company/lead/document.extension, company/calls/call.extension or company/brand/logo.extension. All server-made. */
export const KEY = new RegExp(`^${UUID}/(?:${UUID}|calls|brand)/${UUID}\.(jpg|png|pdf|mp3|wav|ogg|m4a)$`);

/** Files in a folder on the server. Fine for one server; use a cloud store when there are several. */
export class LocalDiskStorage extends StorageService {
  private readonly root: string;

  constructor(root: string) {
    super();
    this.root = resolve(root);
  }

  /** The path for a key, refusing anything that is not exactly the server's own key format. */
  private pathFor(key: string): string {
    if (!KEY.test(key)) throw new Error('not a valid storage key');
    const full = resolve(join(this.root, key));
    if (!full.startsWith(this.root + sep)) throw new Error('storage key escapes the storage folder');
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data, { flag: 'wx', mode: 0o600 }); // never overwrite
  }

  async get(key: string): Promise<{ stream: Readable; size: number } | null> {
    const path = this.pathFor(key);
    try {
      const info = await stat(path);
      return { stream: createReadStream(path), size: info.size };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.pathFor(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}
