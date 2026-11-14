import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../config/env.js';
import { JobRegistry, JobSpec } from './job-registry.service.js';

const registry = (mode: 'interval' | 'cron') => new JobRegistry({ JOBS_MODE: mode } as Env);
const job = (over: Partial<JobSpec> & { name: string }): JobSpec => ({ group: 'minute', everySec: 60, run: async () => undefined, ...over });

afterEach(() => vi.useRealTimers());

describe('JobRegistry on a server (interval mode)', () => {
  it('runs a job on its own timer, and stops when the app stops', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => undefined);
    const r = registry('interval');
    r.register(job({ name: 'a', everySec: 30, run }));
    await vi.advanceTimersByTimeAsync(95_000);
    expect(run).toHaveBeenCalledTimes(3);
    r.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('can start with a first run before the first period', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => undefined);
    registry('interval').register(job({ name: 'a', everySec: 3600, firstRunMs: 1000, run }));
    await vi.advanceTimersByTimeAsync(1500);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not start a job whose interval is zero, and does not run one twice at once', async () => {
    vi.useFakeTimers();
    const off = vi.fn(async () => undefined);
    let release!: () => void;
    const slow = vi.fn(() => new Promise<void>((res) => (release = res)));
    const r = registry('interval');
    r.register(job({ name: 'off', everySec: 0, run: off }));
    r.register(job({ name: 'slow', everySec: 10, run: slow }));
    await vi.advanceTimersByTimeAsync(35_000);
    expect(off).not.toHaveBeenCalled();
    expect(slow).toHaveBeenCalledTimes(1); // the first run is still going, so the next ticks are skipped
    release();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(slow).toHaveBeenCalledTimes(2);
  });
});

describe('JobRegistry for a scheduler (cron mode)', () => {
  it('keeps no timers: nothing runs until a group is asked for', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => undefined);
    registry('cron').register(job({ name: 'a', everySec: 1, run }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).not.toHaveBeenCalled();
  });

  it('runs only the jobs of the group asked for, one after the other, and one failing job does not stop the rest', async () => {
    const order: string[] = [];
    const r = registry('cron');
    r.register(job({ name: 'first', group: 'minute', run: async () => void order.push('first') }));
    r.register(job({ name: 'broken', group: 'minute', run: async () => { throw new Error('database is down'); } }));
    r.register(job({ name: 'last', group: 'minute', run: async () => void order.push('last') }));
    r.register(job({ name: 'other', group: 'daily', run: async () => void order.push('other') }));
    const out = await r.runGroup('minute');
    expect(order).toEqual(['first', 'last']);
    expect(out.map((o) => [o.name, o.ok])).toEqual([['first', true], ['broken', false], ['last', true]]);
    expect(out[1]!.error).toBe('database is down');
    expect(r.names('daily')).toEqual(['other']);
  });
});
