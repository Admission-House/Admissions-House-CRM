import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { LiveBus } from './live-bus.js';
import { TOPICS, type LiveEvent, type Topic } from './realtime.hub.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads the payload a trigger sent; anything that is not exactly that shape is ignored. */
export function parseEvent(payload: string | undefined): LiveEvent | null {
  if (!payload) return null;
  let raw: { t?: unknown; topic?: unknown; u?: unknown };
  try {
    raw = JSON.parse(payload) as typeof raw;
  } catch {
    return null;
  }
  if (typeof raw.t !== 'string' || !UUID.test(raw.t)) return null;
  if (typeof raw.topic !== 'string' || !(TOPICS as readonly string[]).includes(raw.topic)) return null;
  if (raw.u !== null && raw.u !== undefined && (typeof raw.u !== 'string' || !UUID.test(raw.u))) return null;
  return { t: raw.t, topic: raw.topic as Topic, u: (raw.u as string | null | undefined) ?? null };
}

/**
 * Listens on the database channel the triggers write to (see migration 030) and hands each hint to
 * the connections of this server. Every API server does this, so a change made through one server
 * reaches browsers connected to another. If the connection to the database drops and comes back,
 * hints may have been missed, so everyone is told to ask again.
 */
@Injectable()
export class RealtimeListener implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeListener.name);
  private client: pg.Client | null = null;
  private retry: NodeJS.Timeout | null = null;
  private delayMs = 1_000;
  private stopped = false;
  private everConnected = false;

  constructor(
    private readonly bus: LiveBus,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.env.REALTIME_ENABLED) return;
    void this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    const client = this.client;
    this.client = null;
    await client?.end().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = new pg.Client({ connectionString: this.env.DATABASE_URL, application_name: 'ah-live' });
    try {
      client.on('notification', (msg) => {
        const event = parseEvent(msg.payload);
        if (event) this.bus.emit(event);
      });
      const lost = () => this.reconnect(client);
      client.on('error', lost);
      client.on('end', lost);
      await client.connect();
      await client.query('LISTEN ah_events');
      this.client = client;
      this.delayMs = 1_000;
      // After a gap, events may have been missed: tell everyone to ask again.
      if (this.everConnected) this.bus.emit({ t: '', topic: 'resync', u: null });
      this.everConnected = true;
    } catch (e) {
      this.logger.warn(`live updates could not listen: ${e instanceof Error ? e.message : String(e)}`);
      this.reconnect(client);
    }
  }

  private reconnect(old: pg.Client): void {
    if (this.stopped || this.retry) return;
    if (this.client === old) this.client = null;
    old.removeAllListeners();
    old.on('error', () => undefined);
    void old.end().catch(() => undefined);
    this.retry = setTimeout(() => { this.retry = null; void this.connect(); }, this.delayMs);
    this.retry.unref();
    this.delayMs = Math.min(this.delayMs * 2, 30_000);
  }
}
