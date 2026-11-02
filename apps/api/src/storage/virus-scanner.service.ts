import { Socket } from 'node:net';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';

/**
 * Hands an uploaded file to ClamAV (clamd) before it is kept, using clamd's INSTREAM command over TCP.
 * Off unless CLAMAV_HOST is set. When it is on and clamd cannot be reached, the upload is refused
 * rather than let through unchecked: a file that was not scanned is not a clean file.
 */
@Injectable()
export class VirusScanner {
  private readonly logger = new Logger(VirusScanner.name);

  constructor(@Inject(ENV) private readonly env: Pick<Env, 'CLAMAV_HOST' | 'CLAMAV_PORT' | 'CLAMAV_TIMEOUT_MS'>) {}

  get enabled(): boolean {
    return !!this.env.CLAMAV_HOST;
  }

  async assertClean(data: Buffer): Promise<void> {
    if (!this.enabled) return;
    let reply: string;
    try {
      reply = await this.instream(data);
    } catch (err) {
      this.logger.error(`virus scan unavailable: ${err instanceof Error ? err.message : String(err)}`);
      throw new AppError('SCAN_UNAVAILABLE', 'Files cannot be checked for viruses right now, so the upload was not accepted. Try again in a moment.', 503);
    }
    if (/\sFOUND$/.test(reply)) {
      this.logger.warn(`upload refused by virus scan: ${reply}`);
      throw new AppError('VIRUS_FOUND', 'This file was blocked because it may contain a virus', 422);
    }
    if (!/\sOK$/.test(reply)) {
      this.logger.error(`virus scan gave an unexpected answer: ${reply}`);
      throw new AppError('SCAN_UNAVAILABLE', 'Files cannot be checked for viruses right now, so the upload was not accepted. Try again in a moment.', 503);
    }
  }

  private instream(data: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      const chunks: Buffer[] = [];
      socket.setTimeout(this.env.CLAMAV_TIMEOUT_MS ?? 15_000, () => socket.destroy(new Error('clamd timed out')));
      socket.on('error', reject);
      socket.on('data', (c: Buffer) => chunks.push(c));
      socket.on('close', () => {
        const text = Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim();
        if (text) resolve(text);
        else reject(new Error('clamd closed without an answer'));
      });
      socket.connect(this.env.CLAMAV_PORT ?? 3310, this.env.CLAMAV_HOST!, () => {
        socket.write('zINSTREAM\0');
        for (let i = 0; i < data.length; i += 65_536) {
          const part = data.subarray(i, i + 65_536);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(part.length);
          socket.write(len);
          socket.write(part);
        }
        socket.write(Buffer.alloc(4)); // a zero-length chunk ends the stream
      });
    });
  }
}
