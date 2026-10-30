import { lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { StorageService } from '../storage/storage.service.js';
import { checkRecordingUrl, isPrivateAddress, sniffAudio } from './recording-rules.js';
import { TelephonySettingsService } from './telephony-settings.service.js';

const MAX_ATTEMPTS = 5;
const BATCH = 5;
const TIMEOUT_MS = 30_000;

interface Waiting {
  id: string;
  call_id: string;
  source_url: string;
  attempts: number;
}

/**
 * Downloads call recordings from the provider into private storage. The address comes from the
 * provider, so it is treated as untrusted: only hosts the company named, https, no redirects, no
 * private network addresses (checked when connecting, so a host that changes its answer is caught
 * too), a size limit, and the bytes must really be audio. A failed download is retried with growing
 * gaps, five times, then marked failed.
 */
@Injectable()
export class RecordingFetcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RecordingFetcher.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly settings: TelephonySettingsService,
    private readonly storage: StorageService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    if (this.env.RECORDING_INTERVAL_SEC <= 0) return;
    this.timer = setInterval(() => void this.runSafely(), this.env.RECORDING_INTERVAL_SEC * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async runSafely(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const done = await this.runOnce();
      if (done > 0) this.logger.log(`stored ${done} call recordings`);
    } catch (err) {
      this.logger.error(`recording download failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
  }

  /** One pass over every active company. Returns how many recordings were stored. */
  async runOnce(): Promise<number> {
    const { rows: tenants } = await sql<{ id: string }>`SELECT list_active_tenant_ids() AS id`.execute(this.db.unscoped());
    let stored = 0;
    for (const { id } of tenants) {
      for (const job of await this.claim(id)) if (await this.fetchOne(id, job)) stored++;
    }
    return stored;
  }

  /** Takes a few waiting recordings, noting the attempt first so that two workers never take the same one. */
  private claim(tenantId: string): Promise<Waiting[]> {
    return this.db.withTenant(tenantId, async (trx) => {
      const { rows } = await sql<Waiting>`
        UPDATE call_recordings SET attempts = attempts + 1, last_attempt_at = now()
        WHERE id IN (
          SELECT id FROM call_recordings
          WHERE status = 'pending' AND attempts < ${MAX_ATTEMPTS}
            AND (last_attempt_at IS NULL OR last_attempt_at < now() - make_interval(mins => power(2, attempts)::int))
          ORDER BY created_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
        RETURNING id, call_id, source_url, attempts`.execute(trx);
      return rows;
    });
  }

  private async fetchOne(tenantId: string, job: Waiting): Promise<boolean> {
    try {
      const connection = await this.db.withTenant(tenantId, (trx) => this.settings.credentials(trx, tenantId));
      if (!connection) throw new Error('no telephony connection');
      const insecure = this.env.RECORDING_ALLOW_INSECURE;
      const verdict = checkRecordingUrl(job.source_url, connection.recordingHosts, insecure);
      if (!verdict.ok) throw new Error(`recording address ${verdict.reason}`);

      const data = await this.download(verdict.url, insecure);
      const kind = sniffAudio(data);
      if (!kind) throw new Error('the downloaded file is not audio');

      const key = `${tenantId}/calls/${job.call_id}.${kind.ext}`;
      await this.storage.put(key, data);
      await this.db.withTenant(tenantId, (trx) =>
        sql`UPDATE call_recordings SET status = 'stored', file_key = ${key}, size_bytes = ${data.length}, last_error = NULL WHERE id = ${job.id}`.execute(trx),
      );
      return true;
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      this.logger.warn(`recording ${job.id} attempt ${job.attempts}: ${message}`);
      await this.db.withTenant(tenantId, (trx) =>
        sql`UPDATE call_recordings SET last_error = ${message}, status = ${job.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending'} WHERE id = ${job.id}`.execute(trx),
      );
      return false;
    }
  }

  private download(url: URL, insecure: boolean): Promise<Buffer> {
    const max = this.env.RECORDING_MAX_BYTES;
    const client = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = client.get(
        url,
        {
          timeout: TIMEOUT_MS,
          headers: { accept: 'audio/*', 'accept-encoding': 'identity' },
          // Checked at connection time, on the address actually used.
          lookup: (host, options, callback) => {
            dnsLookup(host, { all: true }, (err, addresses) => {
              if (err) return callback(err, '', 4);
              if (!insecure && addresses.some((a) => isPrivateAddress(a.address))) {
                return callback(new Error('the recording host resolves to a private address'), '', 4);
              }
              const first = addresses[0]!;
              return options.all ? callback(null, addresses as never, undefined as never) : callback(null, first.address, first.family);
            });
          },
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`the provider answered ${res.statusCode}`));
          }
          const declared = Number(res.headers['content-length']);
          if (Number.isFinite(declared) && declared > max) {
            res.resume();
            return reject(new Error('the recording is larger than the limit'));
          }
          const chunks: Buffer[] = [];
          let size = 0;
          let tooBig = false;
          res.on('data', (chunk: Buffer) => {
            if (tooBig) return;
            size += chunk.length;
            if (size > max) {
              tooBig = true;
              reject(new Error('the recording is larger than the limit'));
              req.destroy();
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => (tooBig ? undefined : resolve(Buffer.concat(chunks))));
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error('the provider took too long')));
      req.on('error', reject);
    });
  }
}
