import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import type { Env } from '../config/env.js';
import { KEY, StorageService } from './storage.service.js';

/** The minimum of the S3 client this class uses, so a test can stand in for it. */
export interface S3Like {
  send(command: unknown): Promise<unknown>;
}

/**
 * Files in an S3-compatible bucket. The bucket must be private: files are only ever handed out
 * through the CRM (login or short-lived signed link), never by a public bucket address.
 */
export class S3Storage extends StorageService {
  constructor(
    private readonly client: S3Like,
    private readonly bucket: string,
  ) {
    super();
  }

  static fromEnv(env: Env): S3Storage {
    const client = new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: env.S3_ACCESS_KEY_ID!, secretAccessKey: env.S3_SECRET_ACCESS_KEY! },
    });
    return new S3Storage(client, env.S3_BUCKET!);
  }

  private check(key: string): string {
    if (!KEY.test(key)) throw new Error('not a valid storage key');
    return key;
  }

  async put(key: string, data: Buffer): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.check(key), Body: data, ContentLength: data.length, }));
  }

  async get(key: string): Promise<{ stream: Readable; size: number } | null> {
    try {
      const res = (await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.check(key) }))) as { Body?: unknown; ContentLength?: number };
      if (!res.Body) return null;
      return { stream: res.Body as Readable, size: res.ContentLength ?? 0 };
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.check(key) }));
  }
}
