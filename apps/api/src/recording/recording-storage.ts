import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { Inject, Injectable } from '@nestjs/common';
import type { Readable } from 'node:stream';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';

/** The little of the S3 client this class uses, so a test can stand in for it. */
export interface S3Like {
  send(command: unknown): Promise<unknown>;
}

export interface StoredFile {
  key: string;
  size: number;
}

/**
 * The private bucket the recordings are in. Agora writes there with its own key; this server reads, lists and
 * deletes with a different key, which is never given to Agora or to a browser. Files leave only through the CRM:
 * a signed, short-lived link, checked against who may see the session.
 */
@Injectable()
export class RecordingStorage {
  /** Replaced in tests. */
  client: S3Like | null = null;

  constructor(@Inject(ENV) private readonly env: Env) {}

  private s3(): S3Like {
    this.client ??= new S3Client({
      region: this.env.RECORDING_S3_REGION,
      credentials: {
        accessKeyId: this.env.RECORDING_S3_ACCESS_KEY_ID!,
        secretAccessKey: this.env.RECORDING_S3_SECRET_ACCESS_KEY!,
      },
    });
    return this.client;
  }

  private get bucket(): string {
    return this.env.RECORDING_S3_BUCKET!;
  }

  /** Every file under a folder, for finding what Agora wrote. */
  async list(prefix: string): Promise<StoredFile[]> {
    const out: StoredFile[] = [];
    let token: string | undefined;
    do {
      const res = (await this.s3().send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: `${prefix}/`,
          ContinuationToken: token,
        }),
      )) as {
        Contents?: { Key?: string; Size?: number }[];
        IsTruncated?: boolean;
        NextContinuationToken?: string;
      };
      for (const o of res.Contents ?? [])
        if (o.Key) out.push({ key: o.Key, size: Number(o.Size ?? 0) });
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async size(key: string): Promise<number | null> {
    try {
      const res = (await this.s3().send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      )) as { ContentLength?: number };
      return Number(res.ContentLength ?? 0);
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === 'NotFound' || e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404)
        return null;
      throw err;
    }
  }

  /** The file, or a part of it (a browser asks for parts when someone skips ahead). */
  async get(
    key: string,
    range?: { start: number; end: number },
  ): Promise<{ stream: Readable; size: number; total: number } | null> {
    try {
      const res = (await this.s3().send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Range: range ? `bytes=${range.start}-${range.end}` : undefined,
        }),
      )) as {
        Body?: unknown;
        ContentLength?: number;
        ContentRange?: string;
      };
      if (!res.Body) return null;
      const total = res.ContentRange
        ? Number(res.ContentRange.split('/')[1])
        : Number(res.ContentLength ?? 0);
      return { stream: res.Body as Readable, size: Number(res.ContentLength ?? 0), total };
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.s3().send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
