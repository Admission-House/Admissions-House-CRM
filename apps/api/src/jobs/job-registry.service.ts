import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';

/**
 * How often a job needs to run, as a group. On a server each job keeps its own timer. On Vercel there is no
 * server to keep a timer, so a Cron entry calls a whole group instead: a few calls a day, not one per job.
 */
export type JobGroup = 'minute' | 'quarter' | 'daily';
export const JOB_GROUPS: readonly JobGroup[] = ['minute', 'quarter', 'daily'];

export interface JobSpec {
  name: string;
  group: JobGroup;
  /** Seconds between runs when the API runs as a server. Zero or less switches the job off. */
  everySec: number;
  /** A first run this long after start (server mode only), for jobs that should not wait a whole period. */
  firstRunMs?: number;
  /** The work. It must be safe to run twice at once and must not throw for ordinary trouble. */
  run: () => Promise<unknown>;
}

export type JobOutcome = { name: string; ok: boolean; ms: number; error?: string };

/**
 * The one place that decides when background work runs. A job says what it does and how often; this class
 * either runs it on a timer (JOBS_MODE=interval, a server) or leaves it for a scheduler to call
 * (JOBS_MODE=cron, Vercel). The jobs themselves are the same in both modes.
 */
@Injectable()
export class JobRegistry implements OnModuleDestroy {
  private readonly logger = new Logger(JobRegistry.name);
  private readonly jobs = new Map<string, JobSpec>();
  private readonly running = new Set<string>();
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(@Inject(ENV) private readonly env: Env) {}

  register(spec: JobSpec): void {
    if (spec.everySec <= 0) return; // switched off by its own setting
    this.jobs.set(spec.name, spec);
    if (this.env.JOBS_MODE !== 'interval') return;
    const tick = () => void this.runOne(spec);
    if (spec.firstRunMs !== undefined) this.timers.push(setTimeout(tick, spec.firstRunMs).unref());
    this.timers.push(setInterval(tick, spec.everySec * 1000).unref());
  }

  names(group?: JobGroup): string[] {
    return [...this.jobs.values()].filter((j) => !group || j.group === group).map((j) => j.name);
  }

  /** Runs every job of a group, one after the other. A failing job does not stop the others. */
  async runGroup(group: JobGroup): Promise<JobOutcome[]> {
    const out: JobOutcome[] = [];
    for (const spec of this.jobs.values()) if (spec.group === group) out.push(await this.runOne(spec));
    return out;
  }

  private async runOne(spec: JobSpec): Promise<JobOutcome> {
    if (this.running.has(spec.name)) return { name: spec.name, ok: true, ms: 0 }; // the last run is still going
    this.running.add(spec.name);
    const started = Date.now();
    try {
      await spec.run();
      return { name: spec.name, ok: true, ms: Date.now() - started };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error(`job ${spec.name} failed: ${error}`);
      return { name: spec.name, ok: false, ms: Date.now() - started, error: error.slice(0, 200) };
    } finally {
      this.running.delete(spec.name);
    }
  }

  onModuleDestroy(): void {
    for (const t of this.timers) clearTimeout(t);
  }
}
