import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from './database.service.js';

const MONTHS_AHEAD = 12;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/**
 * Keeps the monthly partitions of the big tables (calls, lead activity, notifications, audit log)
 * created a year ahead. Without it the calendar would run past the last partition and new rows
 * would pile into the catch-all one, which then blocks creating the real month. The database
 * function is safe to run often and on several servers at once.
 */
@Injectable()
export class PartitionKeeperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PartitionKeeperService.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly db: DatabaseService) {}

  onModuleInit(): void {
    // Not in tests: they run against a throw-away setup and must stay quiet.
    if (process.env.NODE_ENV === 'test') return;
    void this.runSafely();
    this.timer = setInterval(() => void this.runSafely(), SIX_HOURS_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async ensureOnce(): Promise<number> {
    const { rows } = await sql<{ n: number }>`SELECT ensure_partitions(${MONTHS_AHEAD}) AS n`.execute(this.db.unscoped());
    return rows[0]?.n ?? 0;
  }

  private async runSafely(): Promise<void> {
    try {
      await this.ensureOnce();
    } catch (err) {
      this.logger.error(`could not create the next monthly partitions: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
